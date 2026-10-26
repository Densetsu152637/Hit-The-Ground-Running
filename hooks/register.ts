import type { EngineInterface, Register, SessionRateLimit, Timer } from 'claude-code'

import {
  COMPACT_ABOVE, GATE, LABEL, MAX_REARMS, SHORT, WARN,
  contextPercent, effective, fmtClock, fmtDuration, gating, jitter, levelOf, meter, parseWhen, pct,
} from './logic'
import type { Effective, Kind } from './logic'

// Hit The Ground Running: pushes the plan's usage readings to the model, closes the agent-pool gate (no new
// subagents) near a limit, and resumes the session after a cap resets, compacting first when the context is big.

const TAG = '[Hit The Ground Running]'
const RESUME_PROMPT =
  'Usage limits reset (Hit The Ground Running). Continue where you stopped; re-check the agent-pool usage gate before spawning. If a limit is hit again, stop.'
const COMPACT_INSTRUCTIONS = [
  'Hit The Ground Running is compacting before an automatic resume after a usage-limit reset.',
  'Preserve, in this order: the user\'s goals and acceptance checks; the task list or plan and the status of each item;',
  'decisions made and why; active and queued subagent assignments with their agent IDs and what each was asked to do;',
  'files changed and commit SHAs; and the exact next step to take when work resumes.',
].join(' ')
const GATE_DENY =
  `${TAG} Agent-pool usage gate is closed: spawn no new subagents; let running ones finish, or wait for the reset. Messaging a running agent (SendMessage) is still allowed.`

const MS_MIN = 60_000
const REOPEN_SLACK_MS = 2_000
const PERIOD_SLACK_MS = 10 * MS_MIN
const MAX_OVERDUE_MS = 24 * 3_600_000
const NATIVE_KEEP_MS = 6 * 3_600_000
const DEFER_MS = 30_000
const MAX_DEFER = 20
const WARN_BEFORE_MS = MS_MIN
const TICK_MS = 15_000
const NO_READING_RETRY_MS = 15 * MS_MIN

type Owner = 'mod' | 'native'
type Reason = 'rate_limit-5h' | 'rate_limit-weekly' | 'pause' | 'native-5h'

/** The pending resume: persisted in `$.store` so a reload or an app restart can arm it again. */
type Resume = {
  sessionId: string
  /** When the cap resets (or the time the user paused until), epoch ms. */
  resetsAt: number
  /** When the resume actually fires: resetsAt plus jitter. */
  fireAt: number
  reason: Reason
  attempts: number
  haltedAt: number
  owner: Owner
}

type Tier = { resets: number; level: number }

// Machine origins of a prompt: everything else (composer, bridge, sdk, unclassified, channel) may be the person.
const MACHINE_ORIGINS = new Set([
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer',
  'observer-activity', 'auto-continuation', 'plugin',
])

const isResume = (v: unknown): v is Resume => {
  const r = v as Resume | null
  return (
    typeof r === 'object' && r !== null && typeof r.sessionId === 'string' && typeof r.resetsAt === 'number' &&
    typeof r.fireAt === 'number' && typeof r.attempts === 'number' && (r.owner === 'mod' || r.owner === 'native') &&
    typeof r.reason === 'string' && typeof r.haltedAt === 'number'
  )
}

const freshState = () => ({
  sid: '',
  gated: false,
  tiers: {} as Partial<Record<Kind, Tier>>,
  eff: [] as Effective[],
  resume: null as Resume | null,
  fireTimer: null as Timer | null,
  warnTimer: null as Timer | null,
  tick: null as Timer | null,
  reopenTimer: null as Timer | null,
  deferrals: 0,
  firing: false,
  mainTurn: '',
  /** The 5-hour reset whose period this session was already auto-paused in, epoch ms (0: none). */
  pausedFor: 0,
})

let s = freshState()

const cfg = { ownsFiveHour: false, resumesWeekly: true, autoPauseAt: null as number | null }

const resumeKey = () => `resume:${s.sid}`
const tiersKey = () => `tiers:${s.sid}`

const toast = ($: EngineInterface, text: string, timeoutMs = 8000) => {
  try { $.ui.toast(text, { timeoutMs }) } catch { /* a surface without toasts */ }
}

const note = async ($: EngineInterface, text: string) => {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch { /* the engine refused the row: the gate still holds through the tool hooks */ }
}

const gateText = (eff: readonly Effective[], now: number): string =>
  gating(eff).map(x => `${LABEL[x.kind]} usage ${pct(x.percent)}${x.resetsAt ? ` (resets ${fmtClock(x.resetsAt, now)})` : ''}`).join(' and ')

// ---- status line -------------------------------------------------------------------------------------------------

const setStatus = ($: EngineInterface, now: number) => {
  try {
    // Plain text is all a status line takes: block meters and colored dots stand in for a drawing.
    const parts = [s.gated ? '🔴 Gate closed' : '🟢 Gate open']
    if (s.eff.length === 0) parts.push('waiting for a usage reading')
    else parts.push(...s.eff.map(x => `${SHORT[x.kind]} ${meter(x.percent)} ${Math.round(x.percent)}%${levelOf(x.kind, x.percent) === 1 ? ' ⚠' : ''}`))
    const r = s.resume
    if (r?.owner === 'mod') parts.push(`⏰ Resume ${fmtClock(r.fireAt, now)} (in ${fmtDuration(r.fireAt - now)})`)
    else if (r?.owner === 'native') parts.push(`⏰ Native resume ~${fmtClock(r.resetsAt, now)}`)
    $.ui.status(parts.join('  ·  '))
  } catch { /* no status line on this surface */ }
}

const refreshStatus = async ($: EngineInterface) => setStatus($, await $.clock.now())

// ---- usage tiers and the gate -----------------------------------------------------------------------------------

const persistTiers = async ($: EngineInterface) => {
  await $.store.set(tiersKey(), { tiers: s.tiers, gated: s.gated, pausedFor: s.pausedFor })
}

/** Compares a reading with the tiers: one note per tier crossing per reset period, one when the gate reopens. */
const evaluate = async ($: EngineInterface, readings: readonly SessionRateLimit[]) => {
  const now = await $.clock.now()
  const eff = effective(readings, now)
  s.eff = eff
  const notes: string[] = []
  let gateNoted = false
  for (const x of eff) {
    const t = s.tiers[x.kind] ?? (s.tiers[x.kind] = { resets: 0, level: 0 })
    if (x.isExpired) t.level = 0
    else {
      if (t.resets && x.resetsAt !== undefined && Math.abs(x.resetsAt - t.resets) > PERIOD_SLACK_MS) t.level = 0
      if (x.resetsAt !== undefined) t.resets = x.resetsAt
    }
    const level = levelOf(x.kind, x.percent)
    if (level <= t.level) continue
    t.level = level
    const when = x.resetsAt ? ` (resets ${fmtClock(x.resetsAt, now)})` : ''
    if (level === 2) {
      gateNoted = true
      notes.push(`${TAG} ${LABEL[x.kind]} usage ${pct(x.percent)}${when}. Agent-pool gate closed: spawn no new subagents; let running ones finish.`)
    } else {
      notes.push(`${TAG} ${LABEL[x.kind]} usage ${pct(x.percent)}${when}. Approaching the agent-pool gate at ${GATE[x.kind]}%: keep new subagent spawns to what the task needs.`)
    }
  }
  const closing = gating(eff)
  const isGated = closing.length > 0
  let toastText = ''
  if (isGated && !s.gated) {
    s.gated = true
    toastText = `Agent-pool gate closed: ${gateText(eff, now)}. No new subagents until it resets.`
    if (!gateNoted) notes.push(`${TAG} ${gateText(eff, now)}. Agent-pool gate closed: spawn no new subagents; let running ones finish.`)
  } else if (!isGated && s.gated) {
    s.gated = false
    const readingsText = eff.map(x => `${LABEL[x.kind]} ${pct(x.percent)}`).join(', ')
    toastText = 'Agent-pool gate reopened: usage limits reset.'
    notes.push(`${TAG} Usage limits reset${readingsText ? ` (${readingsText})` : ''}. Agent-pool gate reopened: subagents may be spawned again, within the workflow's usage gates.`)
  }
  for (const text of notes) await note($, text)
  if (toastText) toast($, toastText)

  s.reopenTimer?.cancel()
  s.reopenTimer = null
  if (isGated) {
    const until = Math.max(...closing.map(x => x.resetsAt ?? now + NO_READING_RETRY_MS))
    s.reopenTimer = $.clock.after(Math.max(until - now, 0) + REOPEN_SLACK_MS, () => { void recheck($) })
  }
  await persistTiers($)
  setStatus($, now)
  await autoPause($, eff, now)
}

const recheck = async ($: EngineInterface) => {
  try { await evaluate($, (await $.session.usage()).rateLimits) } catch { /* the next measurement tries again */ }
}

/** The gate as the usage stands now, read fresh: the spawn hooks do not trust a cached verdict. */
const gateNow = async ($: EngineInterface): Promise<string | null> => {
  const now = await $.clock.now()
  const eff = effective((await $.session.usage()).rateLimits, now)
  const text = gateText(eff, now)
  return text ? `${TAG} Agent-pool usage gate is closed (${text}): spawn no new subagents; let running ones finish, or wait for the reset. Messaging a running agent (SendMessage) is still allowed.` : null
}

// ---- pending resume ---------------------------------------------------------------------------------------------

const stopTimers = () => {
  s.fireTimer?.cancel(); s.fireTimer = null
  s.warnTimer?.cancel(); s.warnTimer = null
  s.tick?.cancel(); s.tick = null
}

const forget = async ($: EngineInterface) => {
  stopTimers()
  s.resume = null
  s.deferrals = 0
  try { await $.store.delete(resumeKey()) } catch { /* nothing stored */ }
  await refreshStatus($)
}

const arm = async ($: EngineInterface) => {
  stopTimers()
  const r = s.resume
  if (!r || r.owner !== 'mod') return
  const now = await $.clock.now()
  s.fireTimer = $.clock.after(Math.max(r.fireAt - now, 0), () => { void fire($) })
  const untilWarn = r.fireAt - WARN_BEFORE_MS - now
  s.warnTimer = $.clock.after(Math.max(untilWarn, 0), () => {
    toast($, `Resuming in about a minute (Hit The Ground Running). /htgr-cancel to stop it.`, 10_000)
  })
  s.tick = $.clock.every(TICK_MS, () => { void refreshStatus($) })
  setStatus($, now)
}

const schedule = async ($: EngineInterface, r: Omit<Resume, 'sessionId' | 'fireAt'>, spread: number) => {
  s.sid ||= await $.session.id()
  s.resume = { ...r, sessionId: s.sid, fireAt: r.resetsAt + spread }
  await $.store.set(resumeKey(), s.resume)
  await arm($)
}

const giveUp = async ($: EngineInterface, why: string) => {
  await forget($)
  const text = `Not resuming (Hit The Ground Running): ${why}. Continue yourself once usage allows.`
  toast($, text, 15_000)
  try { await $.ui.notify(text) } catch { /* no notification channel */ }
}

type CompactOutcome = { text: string; isCompacted: boolean; isFailed: boolean }

/** Compacts only when the context is more than COMPACT_ABOVE full and the session is idle between turns. */
const compactIfNeeded = async ($: EngineInterface): Promise<CompactOutcome> => {
  const { context } = await $.session.usage()
  const fill = contextPercent(context)
  if (fill === undefined) return { text: 'context size unreadable, compaction skipped', isCompacted: false, isFailed: false }
  if (fill <= COMPACT_ABOVE) return { text: `context ${Math.round(fill)}% full, no compaction needed`, isCompacted: false, isFailed: false }
  if (s.mainTurn) return { text: 'a turn is running, compaction skipped', isCompacted: false, isFailed: false }
  try {
    const done = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (done.skip !== undefined) return { text: `compaction vetoed (${done.skip})`, isCompacted: false, isFailed: true }
    const sizes = done.tokensBefore !== undefined && done.tokensAfter !== undefined ? ` (${done.tokensBefore} to ${done.tokensAfter} tokens)` : ''
    return { text: `context compacted from ${Math.round(fill)}%${sizes}`, isCompacted: true, isFailed: false }
  } catch (err) {
    return { text: `compaction failed (${err instanceof Error ? err.message : String(err)})`, isCompacted: false, isFailed: true }
  }
}

const fire = async ($: EngineInterface) => {
  const r = s.resume
  if (s.firing || !r || r.owner !== 'mod') return
  s.firing = true
  try {
    const now = await $.clock.now()
    if (s.mainTurn) {
      if (s.deferrals >= MAX_DEFER) return await giveUp($, 'the session never went idle')
      s.deferrals++
      r.fireAt = now + DEFER_MS
      await $.store.set(resumeKey(), r)
      await arm($)
      return
    }
    const usage = await $.session.usage()
    const blocking = gating(effective(usage.rateLimits, now))
    if (blocking.length > 0) {
      if (r.attempts >= MAX_REARMS) return await giveUp($, `usage is still at the gate after ${r.attempts} re-arms`)
      r.attempts++
      r.resetsAt = Math.max(...blocking.map(x => x.resetsAt ?? now + NO_READING_RETRY_MS))
      r.fireAt = r.resetsAt + jitter()
      await $.store.set(resumeKey(), r)
      await arm($)
      toast($, `Usage is still high (${gateText(effective(usage.rateLimits, now), now)}); resume re-armed for ${fmtClock(r.fireAt, now)} (attempt ${r.attempts} of ${MAX_REARMS}).`, 12_000)
      return
    }
    const compaction = await compactIfNeeded($)
    await forget($)
    toast($, compaction.isFailed ? `Resuming: ${compaction.text}; resuming anyway.` : `Resuming: ${compaction.text}.`, 10_000)
    try {
      await $.prompt.submit({ text: RESUME_PROMPT })
    } catch (err) {
      toast($, `Could not submit the resume prompt (${err instanceof Error ? err.message : String(err)}).`, 15_000)
    }
  } catch (err) {
    toast($, `Resume failed (${err instanceof Error ? err.message : String(err)}). /htgr shows the state.`, 15_000)
  } finally {
    s.firing = false
  }
}

/** Schedules a mod resume at `resetsAt` (plus `spread`) and stops the running main turn, if any. */
const pauseUntil = async ($: EngineInterface, now: number, resetsAt: number, spread: number): Promise<string> => {
  await schedule($, { resetsAt, reason: 'pause', attempts: 0, haltedAt: now, owner: 'mod' }, spread)
  let stopped = ''
  if (s.mainTurn) {
    try {
      await $.turn.abort({ turnId: s.mainTurn })
      stopped = 'Stopped the running turn. '
    } catch {
      stopped = 'Could not stop the running turn (press stop yourself). '
    }
  }
  const at = s.resume?.fireAt ?? resetsAt
  return `${stopped}Resume scheduled for ${fmtClock(at, now)} (in ${fmtDuration(at - now)}). Keep the computer awake; any prompt you type cancels it, as does /htgr-cancel.`
}

/**
 * The automatic /htgr-pause: once per 5-hour period, a session whose main turn is running when the 5-hour reading
 * reaches the auto-pause tier is stopped and resumed after the reset. An idle session has nothing to stop; it pauses
 * on its first response if it starts working in the same period. Typing after a pause cancels it for that period.
 */
const autoPause = async ($: EngineInterface, eff: readonly Effective[], now: number) => {
  const at = cfg.autoPauseAt
  const x = eff.find(w => w.kind === 'five_hour')
  if (at === null || !x || x.isExpired || x.resetsAt === undefined || x.percent < at) return
  if (!s.mainTurn || s.resume || Math.abs(s.pausedFor - x.resetsAt) <= PERIOD_SLACK_MS) return
  s.pausedFor = x.resetsAt
  await persistTiers($)
  const text = await pauseUntil($, now, x.resetsAt, jitter())
  toast($, `5-hour usage ${pct(x.percent)}: auto-paused at ${at}% (Hit The Ground Running). ${text}`, 15_000)
}

const rehydrate = async ($: EngineInterface) => {
  const saved = await $.store.get(resumeKey())
  if (saved === undefined) return
  const now = await $.clock.now()
  if (!isResume(saved) || saved.sessionId !== s.sid || now - saved.fireAt > (saved.owner === 'native' ? NATIVE_KEEP_MS : MAX_OVERDUE_MS)) {
    await $.store.delete(resumeKey())
    return
  }
  s.resume = saved
  if (saved.owner === 'mod') {
    // Overdue after an app restart: fire shortly, once the session has finished loading.
    if (saved.fireAt <= now) saved.fireAt = now + 10_000
    await arm($)
  } else {
    setStatus($, now)
  }
}

export const register: Register = (on, options) => {
  s = freshState()
  cfg.ownsFiveHour = options.fiveHourResume === 'mod'
  cfg.resumesWeekly = options.weeklyResume !== 'off'
  const pauseAt = Number(options.autoPause)
  cfg.autoPauseAt = Number.isFinite(pauseAt) && pauseAt > 0 ? pauseAt : null

  // ---- hooks ------------------------------------------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      s.sid = await $.session.id()
      await $.command.register({
        name: 'htgr',
        description: 'Hit The Ground Running: usage readings, agent-pool gate, pending resume',
        immediate: true,
      })
      await $.command.register({
        name: 'htgr-pause',
        description: 'Stop the current work and resume at a time or at the next 5-hour reset (Hit The Ground Running)',
        argumentHint: '[HH:MM | reset]',
        immediate: true,
      })
      await $.command.register({
        name: 'htgr-cancel',
        description: 'Cancel the pending automatic resume (Hit The Ground Running)',
        immediate: true,
      })
      const savedTiers = (await $.store.get(tiersKey())) as { tiers?: Partial<Record<Kind, Tier>>; gated?: boolean; pausedFor?: number } | undefined
      if (savedTiers && typeof savedTiers === 'object') {
        s.tiers = savedTiers.tiers ?? {}
        s.gated = savedTiers.gated === true
        s.pausedFor = typeof savedTiers.pausedFor === 'number' ? savedTiers.pausedFor : 0
      }
      await rehydrate($)
      await recheck($)
    } catch (err) {
      toast($, `Hit The Ground Running could not start (${err instanceof Error ? err.message : String(err)}).`, 15_000)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    try {
      s.sid ||= e.sessionId
      if (e.sessionId === s.sid) {
        // A cleared conversation has nothing to resume; any other end may be resumed later, so its schedule stays stored.
        if (e.reason === 'clear') await $.store.delete(resumeKey())
        await $.store.delete(tiersKey())
      }
      stopTimers()
      s.reopenTimer?.cancel()
    } catch { /* ending anyway */ }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try { await evaluate($, e.rateLimits) } catch { /* the next measurement tries again */ }
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) s.mainTurn = e.turnId
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) s.mainTurn = ''
    return next(e)
  })

  // The gate: new spawns are refused while a window is at its gate tier. Running agents and SendMessage are untouched.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const closed = await gateNow($)
    if (closed) return { deny: closed }
    return next(e)
  }).catch(($, e, next) => (!next.called && s.gated ? { deny: GATE_DENY } : next(e)))

  on('agent.spawn', async ($, e, next) => {
    // A resumed agent is the same assignment continuing, not a new one.
    if (e.resume) return next(e)
    const closed = await gateNow($)
    if (closed) return { deny: closed }
    return next(e)
  }).catch(($, e, next) => (!next.called && s.gated && !e.resume ? { deny: GATE_DENY } : next(e)))

  // Halt detection: a rate_limit stop is a plan cap only when a window reads at its gate tier with a reset still ahead
  // (the last reading before a cap is often below 100%; a transient 429 below the gate is ignored).
  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit' && e.agent_id === undefined) {
      try {
        const now = await $.clock.now()
        const usage = await $.session.usage()
        const eff = effective(usage.rateLimits, now)
        const capped = eff.filter(x => x.raw >= GATE[x.kind] && x.resetsAt !== undefined && x.resetsAt > now)
        if (capped.length > 0) {
          s.sid ||= await $.session.id()
          const resetsAt = Math.max(...capped.map(x => x.resetsAt as number))
          const isWeekly = capped.some(x => x.kind === 'seven_day')
          const owner: Owner = isWeekly ? 'mod' : cfg.ownsFiveHour ? 'mod' : 'native'
          const covered = isWeekly ? cfg.resumesWeekly : true
          const keep = s.resume && s.resume.resetsAt >= resetsAt && (s.resume.owner === owner)
          if (covered && !keep) {
            const reason: Reason = isWeekly ? 'rate_limit-weekly' : cfg.ownsFiveHour ? 'rate_limit-5h' : 'native-5h'
            const label = capped.map(x => LABEL[x.kind]).join(' and ')
            if (owner === 'mod') {
              await schedule($, { resetsAt, reason, attempts: 0, haltedAt: now, owner }, jitter())
              toast($, `${label} limit reached. Auto-resume armed for ${fmtClock(s.resume?.fireAt ?? resetsAt, now)}; /htgr-cancel to stop it. Keep the computer awake until then.`, 15_000)
            } else {
              s.resume = { sessionId: s.sid, resetsAt, fireAt: resetsAt, reason, attempts: 0, haltedAt: now, owner }
              await $.store.set(resumeKey(), s.resume)
              setStatus($, now)
              toast($, `${label} limit reached. Resuming is left to the native auto-continue (~${fmtClock(resetsAt, now)}); the mod does not compact in native mode (set fiveHourResume to mod for that).`, 15_000)
            }
          }
        }
      } catch { /* a failed check changes nothing: the session just stays halted */ }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      const kind = e.origin.kind
      const isMine = e.command !== undefined && e.command.name.startsWith('htgr')
      const isPerson = !e.isMeta && !MACHINE_ORIGINS.has(kind) && !isMine
      if (isPerson && s.resume) {
        const owner = s.resume.owner
        await forget($)
        toast($, owner === 'mod' ? 'You are back: the automatic resume was cancelled (Hit The Ground Running).' : 'You are back: pre-resume compaction was cancelled (Hit The Ground Running).')
      } else if (kind === 'auto-continuation' && s.resume?.owner === 'native') {
        // Claude's own auto-continue is resuming. The host refuses a compaction raised from this hook (it would run
        // under the turn the hook holds), so the mod only drops its note here.
        await forget($)
      }
    } catch { /* never stand in the way of a prompt */ }
    return next(e)
  })

  // ---- commands ---------------------------------------------------------------------------------------------------

  on('command.run', { command: 'htgr' }, async $ => {
    const now = await $.clock.now()
    const lines = ['Hit The Ground Running']
    if (s.eff.length === 0) lines.push('usage     no reading yet (readings come from this session\'s API responses)')
    for (const x of s.eff) {
      const reset = x.resetsAt ? `resets ${fmtClock(x.resetsAt, now)}${x.isExpired ? ' (passed)' : ''}` : 'reset unknown'
      lines.push(`${LABEL[x.kind].padEnd(9)} ${pct(x.percent).padStart(6)}  ${reset}  (warn ${WARN[x.kind]}%, gate ${GATE[x.kind]}%)`)
    }
    lines.push(`gate      ${s.gated ? 'CLOSED: no new subagents' : 'open'}`)
    const r = s.resume
    if (!r) lines.push('resume    none pending')
    else if (r.owner === 'mod') lines.push(`resume    ${fmtClock(r.fireAt, now)} (in ${fmtDuration(r.fireAt - now)}), ${r.reason}, re-arms ${r.attempts}/${MAX_REARMS}; /htgr-cancel stops it`)
    else lines.push(`resume    left to the native auto-continue (~${fmtClock(r.resetsAt, now)}); no compaction in native mode`)
    lines.push(`options   fiveHourResume=${cfg.ownsFiveHour ? 'mod' : 'native'} weeklyResume=${cfg.resumesWeekly ? 'on' : 'off'} autoPause=${cfg.autoPauseAt ?? 'off'}`)
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'htgr-cancel' }, async $ => {
    if (!s.resume) return { text: 'Nothing is pending.' }
    await forget($)
    return { text: 'Cancelled the pending resume.' }
  })

  on('command.run', { command: 'htgr-pause' }, async ($, e) => {
    const now = await $.clock.now()
    const when = parseWhen(e.args, now)
    if (when.kind === 'error') return { text: when.message }
    let resetsAt: number
    let spread = 0
    if (when.kind === 'at') resetsAt = when.ms
    else {
      const five = effective((await $.session.usage()).rateLimits, now).find(x => x.kind === 'five_hour' && x.resetsAt !== undefined && x.resetsAt > now)
      if (!five?.resetsAt) return { text: 'No upcoming 5-hour reset is known yet. Give a time: /htgr-pause HH:MM' }
      resetsAt = five.resetsAt
      spread = jitter()
    }
    return { text: await pauseUntil($, now, resetsAt, spread) }
  })
}
