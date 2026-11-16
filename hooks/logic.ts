import type { SessionRateLimit } from 'claude-code'

// Pure helpers of Hit The Ground Running: tiers, readings and time. No engine calls here.

export type Kind = 'five_hour' | 'seven_day'
export const KINDS: readonly Kind[] = ['five_hour', 'seven_day']
export const LABEL: Readonly<Record<Kind, string>> = { five_hour: '5-hour', seven_day: 'weekly' }
export const SHORT: Readonly<Record<Kind, string>> = { five_hour: '5h', seven_day: 'wk' }

/** Warn tiers: the first note to the model. */
export const WARN: Readonly<Record<Kind, number>> = { five_hour: 70, seven_day: 90 }
/** Gate tiers: the agent-pool usage gate of the workflow closes (no new subagents). */
export const GATE: Readonly<Record<Kind, number>> = { five_hour: 85, seven_day: 95 }
/** A window this full has no plan usage left: whatever still runs is drawn from usage credits. */
export const EXHAUSTED = 100
/** Compaction runs only when the context window is more than this full. */
export const COMPACT_ABOVE = 25
/** Resume fires this long after the reset, spread so that many sessions do not wake together. */
export const JITTER_MIN_MS = 30_000
export const JITTER_MAX_MS = 90_000
/** A gate that is still closed when a resume fires re-arms at most this often per halt. */
export const MAX_REARMS = 2

export type Effective = {
  kind: Kind
  /** The window's reading as the last API response gave it. */
  raw: number
  /** The reading after the window's reset passed: a window that rolled over reads 0. */
  percent: number
  /** The reset in epoch milliseconds, when the reading carried a usable one. */
  resetsAt?: number
  /** True when the reading is from a window whose reset has passed. */
  isExpired: boolean
}

/**
 * The five-hour and weekly windows of a reading, aged to `now`. The reading is the last API response's, so after a
 * cap the figures stay frozen at the pre-halt value: a reset in the past means the window has rolled over.
 */
export const effective = (readings: readonly SessionRateLimit[], now: number): Effective[] => {
  const out: Effective[] = []
  for (const kind of KINDS) {
    const r = readings.find(x => x.kind === kind)
    if (!r || typeof r.percentUsed !== 'number') continue
    const at = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    const resetsAt = Number.isFinite(at) ? at : undefined
    const isExpired = resetsAt !== undefined && resetsAt <= now
    out.push({ kind, raw: r.percentUsed, percent: isExpired ? 0 : r.percentUsed, resetsAt, isExpired })
  }
  return out
}

/** 0 below the warn tier, 1 warn, 2 gate. */
export const levelOf = (kind: Kind, percent: number): 0 | 1 | 2 => (percent >= GATE[kind] ? 2 : percent >= WARN[kind] ? 1 : 0)

/** Windows at their gate tier. */
export const atGate = (eff: readonly Effective[]): Effective[] => eff.filter(x => levelOf(x.kind, x.percent) === 2)

/**
 * Windows used up before their reset. The engine reports no credit balance, but a session that still gets responses
 * past an exhausted window is running on usage credits, and one without credits is refused anyway.
 */
export const exhausted = (eff: readonly Effective[]): Effective[] => eff.filter(x => x.percent >= EXHAUSTED)

/** Windows that keep the gate closed now: none on usage credits, where there is no plan usage left to keep. */
export const gating = (eff: readonly Effective[]): Effective[] => (exhausted(eff).length > 0 ? [] : atGate(eff))

/** A five-cell text meter of a percentage, `▰▰▱▱▱`; any use shows at least one cell. */
export const meter = (percent: number, cells = 5): string => {
  const filled = percent <= 0 ? 0 : Math.min(cells, Math.max(1, Math.round((percent / 100) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

export const pct = (n: number): string => `${Math.round(n * 10) / 10}%`

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const two = (n: number): string => String(n).padStart(2, '0')

/** Local clock time, with the weekday when it is not within a day. */
export const fmtClock = (ms: number, now: number): string => {
  const d = new Date(ms)
  const hhmm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return Math.abs(ms - now) > 20 * 3_600_000 ? `${DAYS[d.getDay()]} ${hhmm}` : hhmm
}

export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? two(s % 60) + 's' : ''}`
  const h = Math.floor(m / 60)
  return `${h}h${two(m % 60)}m`
}

export type When = { kind: 'reset' } | { kind: 'at'; ms: number } | { kind: 'error'; message: string }

/** `reset` (or nothing) or a local `HH:MM`, the next time that clock reads. */
export const parseWhen = (arg: string, now: number): When => {
  const text = arg.trim().toLowerCase()
  if (text === '' || text === 'reset') return { kind: 'reset' }
  const m = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!m) return { kind: 'error', message: `"${arg.trim()}" is not a time: use HH:MM (24-hour, local) or reset` }
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return { kind: 'error', message: `"${arg.trim()}" is not a clock time` }
  const d = new Date(now)
  d.setHours(hours, minutes, 0, 0)
  if (d.getTime() <= now + 60_000) d.setDate(d.getDate() + 1)
  return { kind: 'at', ms: d.getTime() }
}

export const jitter = (): number => JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1))

/** Context fill in percent: from the token count when there is one (a whole percentage can hide 25.4), else the reported figure. */
export const contextPercent = (ctx: { tokens?: number; window: number; percent?: number }): number | undefined => {
  if (ctx.tokens !== undefined && ctx.window > 0) return (ctx.tokens / ctx.window) * 100
  return ctx.percent
}

/** The `Personality:` line of a CLAUDE.md, e.g. `Personality: luxion.md`; undefined when absent. */
export const personalityOf = (claudeMd: string): string | undefined => /^\s*Personality:\s*(\S+)/m.exec(claudeMd)?.[1]

/** Makes a workflow file's relative Markdown links absolute, so they resolve from any project. */
export const absoluteLinks = (text: string, dir: string, root: string): string =>
  text
    .replace(/\]\(\.\.\//g, `](${root}/`)
    .replace(/\]\((?!https?:|[A-Za-z]:|\/|#)/g, `](${dir}/`)

const parentOf = (dir: string): string => dir.replace(/\/[^/]*$/, '') || dir

/** The path a CLAUDE.md `@` import names, relative to `dir` unless absolute; `\ ` is an escaped space. */
const importPath = (spec: string, dir: string): string => {
  const p = spec.trim().replace(/\\ /g, ' ').replace(/\\/g, '/')
  return /^([A-Za-z]:)?\//.test(p) ? p : `${dir}/${p.replace(/^\.\//, '')}`
}

/**
 * A CLAUDE.md as the host reads it: each line that is only an `@path` import replaced by that file's text, imports
 * within it expanded too (up to `depth` levels, each file once), and every file's relative links made absolute from
 * its own folder. An import that cannot be read stays as its line, with a note to read it.
 */
export async function expandImports(
  text: string, dir: string, read: (path: string) => Promise<string>, depth = 5, seen: Set<string> = new Set(),
): Promise<string> {
  const out: string[] = []
  for (const line of absoluteLinks(text, dir, parentOf(dir)).split('\n')) {
    const m = /^\s*@(\S.*)$/.exec(line)
    if (!m?.[1]) {
      out.push(line)
      continue
    }
    const path = importPath(m[1], dir)
    const key = path.toLowerCase()
    if (depth <= 0 || seen.has(key)) {
      out.push(line)
      continue
    }
    seen.add(key)
    try {
      out.push((await expandImports((await read(path)).trim(), parentOf(path), read, depth - 1, seen)))
    } catch {
      out.push(`${line} (could not be read here: read ${path} yourself)`)
    }
  }
  return out.join('\n')
}

/** The host's limit on one context entry is 10,000 characters: longer text is split at line ends under this. */
export const ENTRY_MAX = 9_500

/** `text` in pieces of at most `max` characters, cut at line ends where it can be. */
export function chunk(text: string, max = ENTRY_MAX): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

export type Workflow = { root: string; rootText: string; personality: string | undefined }

/**
 * What the loader hands the model at a session start, in entries under the host's per-entry limit: a lead saying what
 * to do with it, the user's instructions (`~/.claude/CLAUDE.md`, imports expanded) when given, and with a workflow its
 * root workflow (complete text in context counts as loaded). A fresh session follows them from its first action; a
 * compacted, resumed or forked one treats them as the rules again, since a summary carries none.
 */
export function loaderContext(source: string, userPath: string, userText: string | undefined, workflow?: Workflow): string[] {
  const isFresh = source === 'startup' || source === 'clear'
  const how = source === 'compact' ? 'compacted' : source === 'fork' ? 'forked' : 'resumed'
  const user = userText ? `the user's instructions (${userPath}, imports expanded)` : ''
  let lead: string[]
  if (workflow) {
    const { root, personality } = workflow
    const persona = personality ? `${root}/personalities/${personality}` : 'the personality its selection names'
    const loaded = [user, `the root workflow (${root}/workflows/AGENTS.root.md)`].filter(Boolean).join(' and ')
    lead = isFresh
      ? [
        'MANDATORY FIRST ACTION for the top-level root, before any other tool call, plan, or reply (including one-line answers):',
        `1. ${loaded[0]?.toUpperCase()}${loaded.slice(1)} ${user ? 'are' : 'is'} loaded below; follow ${user ? 'both' : 'it'}.`,
        `2. Read in one parallel batch: ${root}/workflows/root-delegation.md, ${root}/personalities/README.md, ${persona}.`,
        '3. Then load any further owners the root workflow\'s index triggers for the request, and reply in the selected personality.',
        'Skipping these reads is a workflow violation even when the task looks trivial.',
      ]
      : [
        `Context was ${how}. Summaries are pointers, not rules. Before any substantive work, dispatch, or publication, as the top-level root:`,
        `1. ${loaded[0]?.toUpperCase()}${loaded.slice(1)} below ${user ? 'are' : 'is'} loaded. Re-read root-delegation.md, root-dispatch.md, root-review.md and root-recovery.md under ${root}/workflows/ (and any other owner whose full text is no longer in context).`,
        `2. Reload ${root}/personalities/README.md and ${persona}, and use the personality in every user-facing reply.`,
        '3. Follow root-recovery: send one short restored checkpoint (task, constraints, pending work, active leaves, open review gates, gaps).',
      ]
  } else {
    lead = isFresh
      ? [`The user's own instructions (${userPath}, imports expanded) are below. Follow them from your first action and for the whole session; they rank as the user's explicit instructions.`]
      : [`Context was ${how}. Summaries are pointers, not rules: the user's own instructions (${userPath}, imports expanded) below are the rules again. Follow them before any further work.`]
  }
  const first = [...lead, 'Subagents ignore this message.', ...(userText ? ['', `===== ${userPath} (imports expanded) =====`, userText.trim()] : [])].join('\n')
  const entries = chunk(first)
  if (workflow) {
    const body = absoluteLinks(workflow.rootText.trim(), `${workflow.root}/workflows`, workflow.root)
    entries.push(...chunk([`===== ${workflow.root}/workflows/AGENTS.root.md =====`, body].join('\n')))
  }
  return entries
}

