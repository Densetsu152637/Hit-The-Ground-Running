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

/** Windows that keep the gate closed now. */
export const gating = (eff: readonly Effective[]): Effective[] => eff.filter(x => levelOf(x.kind, x.percent) === 2)

/** An eight-cell text meter of a percentage, `▰▰▰▱▱▱▱▱`; any use shows at least one cell. */
export const meter = (percent: number, cells = 8): string => {
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
