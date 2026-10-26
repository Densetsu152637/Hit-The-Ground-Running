import type { On, SessionRateLimit } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// Shared rig of the tests: the engine beneath the mod, answered from memory. Not a test file itself.

export const PLUGIN = 'hit-the-ground-running'
export const SID = 'sess-1'
export const NOW = Date.parse('2026-10-26T12:00:00Z')
export const HOUR = 3_600_000
export const MIN = 60_000

export const iso = (ms: number): string => new Date(ms).toISOString()
export const five = (percentUsed: number, resetsAt: number): SessionRateLimit => ({ kind: 'five_hour', percentUsed, resetsAt: iso(resetsAt) })
export const week = (percentUsed: number, resetsAt: number): SessionRateLimit => ({ kind: 'seven_day', percentUsed, resetsAt: iso(resetsAt) })

export type Rig = {
  clock: ReturnType<typeof mock.clock>
  /** What the engine would answer `$.session.usage()` with: tests move these. */
  usage: { rateLimits: SessionRateLimit[]; tokens?: number; percent?: number; window: number }
  toasts: string[]
  statuses: Array<string | undefined>
  notified: string[]
  /** Everything the engine saw, in order: `compact`, `submit`, `abort`. */
  events: string[]
  submitted: string[]
  compactions: Array<{ instructions?: string }>
  aborts: string[]
  session: ReturnType<typeof mock.session>
  /** The plugin's `$.store`, in memory. */
  store: Record<string, unknown>
  failCompact: boolean
  vetoCompact: boolean
  failUsage: boolean
}

export type RigOptions = {
  store?: Record<string, unknown>
  rateLimits?: SessionRateLimit[]
  tokens?: number
  /** Start the session (default true). */
  start?: boolean
}

/** Notes the mod appended to the conversation, as text. */
export const notes = (rig: Rig): string[] =>
  rig.session.appended().map(r => {
    const block = r.message.content[0] as { text?: string } | undefined
    return block?.text ?? ''
  })

export const rig = async ($: Engine, on: On, options: RigOptions = {}): Promise<Rig> => {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = JSON.parse(JSON.stringify(options.store ?? {}))
  const session = mock.session(on)
  const r: Rig = {
    clock, session, store,
    usage: { rateLimits: options.rateLimits ?? [], tokens: options.tokens, window: 1_000_000 },
    toasts: [], statuses: [], notified: [], events: [], submitted: [], compactions: [], aborts: [],
    failCompact: false, vetoCompact: false, failUsage: false,
  }
  on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
  on('store.set', (_$, e) => { store[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } as never })
  on('store.delete', (_$, e) => { delete store[e.key]; return { value: undefined } as never })
  on('store.keys', () => ({ value: Object.keys(store) }) as never)
  on('session.id', () => ({ value: SID }) as never)
  on('session.usage', () => {
    if (r.failUsage) throw new Error('usage unavailable')
    return { value: { startedAt: 0, context: { window: r.usage.window, tokens: r.usage.tokens, percent: r.usage.percent }, rateLimits: r.usage.rateLimits } } as never
  })
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }) as never)
  on('classic.StopFailure', () => ({}) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => { r.toasts.push(e.text); return { value: undefined } as never })
  on('ui.status', (_$, e) => { r.statuses.push(e.text); return { value: undefined } as never })
  on('ui.notify', (_$, e) => { r.notified.push(e.text); return { value: { isSent: true, channel: 'test' } } as never })
  on('turn.abort', (_$, e) => { r.aborts.push(e.turnId); return { value: undefined } as never })
  on('session.compact', async (_$, e) => {
    r.events.push('compact')
    r.compactions.push({ instructions: e.instructions })
    if (r.failCompact) throw new Error('compaction refused')
    if (r.vetoCompact) return { skip: 'PreCompact hook blocked it' } as never
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: r.usage.tokens, tokensAfter: 20_000 } as never
  })
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'plugin') {
      r.events.push('submit')
      r.submitted.push(e.text)
    } else {
      r.events.push(`prompt:${e.origin.kind}`)
    }
    return { text: e.text }
  })
  if (options.start !== false) await start($)
  return r
}

/** What the mod keeps in its store under `key`. */
export const stored = async (_$: Engine, r: Rig, key: string): Promise<unknown> => r.store[key]

export const start = async ($: Engine): Promise<void> => {
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

/** A rate-limit measurement as the engine pushes it after a response. */
export const measure = async ($: Engine, r: Rig, rateLimits: SessionRateLimit[]): Promise<void> => {
  r.usage.rateLimits = rateLimits
  await $.session.measure({ context: { window: r.usage.window, tokens: r.usage.tokens }, rateLimits, changed: ['rateLimits'] } as never)
}

/** The model's rate_limit stop, as the classic StopFailure hook raises it. */
export const halt = async ($: Engine, error = 'rate_limit'): Promise<void> => {
  await $.classic.StopFailure({ error } as never)
}

/** A prompt typed by the person. */
export const typed = async ($: Engine, text = 'hello'): Promise<void> => {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
}

export const runCommand = async ($: Engine, command: string, args = ''): Promise<string> => {
  const done = await $.command.run({
    command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
  } as never)
  return String((done as { text?: string }).text ?? '')
}

export const SPAWN = {
  tool_use_id: 't1',
  prompt: 'Role: leaf; Profile: implementer',
  description: 'Side work',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
}

/** Lets the engine beneath answer Agent and SendMessage calls and spawns; returns what reached it. */
export const spawns = (on: On): { agentCalls: number; sendCalls: number; spawned: number } => {
  const seen = { agentCalls: 0, sendCalls: 0, spawned: 0 }
  on('tool.call', { tool: 'Agent' }, () => { seen.agentCalls++; return { result: 'started' } as never })
  on('tool.call', { tool: 'SendMessage' }, () => { seen.sendCalls++; return { result: { success: true } } as never })
  on('agent.spawn', () => { seen.spawned++; return { model: 'claude-haiku-4-5', agentId: 'a1' } })
  return seen
}

export const AGENT_CALL = { tool: 'Agent', description: 'Side work', prompt: 'Role: leaf; Profile: implementer', subagent_type: 'general-purpose' }
