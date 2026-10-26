import { expect, test } from 'claude-code/testing'

import { HOUR, NOW, SID, five, halt, rig, stored, typed } from './harness'

const RESUME_TEXT = 'Usage limits reset (Hit The Ground Running). Continue where you stopped; re-check the agent-pool usage gate before spawning. If a limit is hit again, stop.'
const MOD = { fiveHourResume: 'mod' } as const
const KEY = `resume:${SID}`
const reset5 = NOW + 2 * HOUR
// Past the reset and its jitter.
const PAST = 2 * HOUR + 91_000

test('compaction: more than 25% of the window used and the limits reset: compact, then resume, in that order', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: 300_000 })
  await halt($)
  await r.clock.advance(PAST)
  expect(r.events).toEqual(['compact', 'submit'])
  expect(r.submitted).toEqual([RESUME_TEXT])
  expect(r.compactions).toHaveLength(1)
  const said = r.compactions[0].instructions ?? ''
  for (const keep of ['goals and acceptance checks', 'task list or plan', 'decisions made', 'subagent assignments', 'agent IDs', 'commit SHAs', 'exact next step']) {
    expect(said).toContain(keep)
  }
  expect(r.toasts.some(t => t.includes('context compacted from 30%'))).toBe(true)
})

for (const [name, ctx] of [
  ['exactly 25%', { tokens: 250_000 }],
  ['10%', { tokens: 100_000 }],
  ['an unreadable size', { tokens: undefined }],
] as const) {
  test(`compaction: skipped at ${name}, and the resume still goes`, { options: MOD }, async ($, on) => {
    const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: ctx.tokens })
    await halt($)
    await r.clock.advance(PAST)
    expect(r.compactions).toHaveLength(0)
    expect(r.events).toEqual(['submit'])
  })
}

test('compaction: with no token count it falls back to the reported percentage', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  r.usage.percent = 40
  await halt($)
  await r.clock.advance(PAST)
  expect(r.events).toEqual(['compact', 'submit'])
})

test('compaction: never while the usage is still at the gate; the resume waits and compaction with it', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: 600_000 })
  await halt($)
  r.usage.rateLimits = [five(95, reset5 + 3 * HOUR)]
  await r.clock.advance(PAST)
  expect(r.compactions).toHaveLength(0)
  expect(r.submitted).toEqual([])
  expect(r.events).toEqual([])
  // Once that window resets, the re-armed resume compacts and resumes.
  await r.clock.advance(3 * HOUR + 91_000)
  expect(r.events).toEqual(['compact', 'submit'])
})

test('compaction: a failed compaction does not stop the resume, and the toast says so', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: 500_000 })
  r.failCompact = true
  await halt($)
  await r.clock.advance(PAST)
  expect(r.events).toEqual(['compact', 'submit'])
  expect(r.toasts.some(t => t.includes('compaction failed') && t.includes('resuming anyway'))).toBe(true)
})

test('compaction: a vetoed compaction (skip) also resumes anyway', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: 500_000 })
  r.vetoCompact = true
  await halt($)
  await r.clock.advance(PAST)
  expect(r.submitted).toEqual([RESUME_TEXT])
  expect(r.toasts.some(t => t.includes('compaction vetoed') && t.includes('resuming anyway'))).toBe(true)
})

test('compaction: the custom pause compacts too when its time comes and the context is big', async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(40, reset5)], tokens: 400_000 })
  await $.command.run({ command: 'htgr-pause', args: 'reset', origin: { kind: 'composer' }, presentation: {} } as never)
  await r.clock.advance(PAST)
  expect(r.events).toEqual(['compact', 'submit'])
})

test('native mode: the mod never compacts (the host refuses it inside the prompt hook); the auto-continue prompt clears its note', async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: 400_000 })
  await halt($)
  expect(await stored($, r, KEY)).toMatchObject({ owner: 'native' })
  await r.clock.advance(PAST)
  expect(r.events).toEqual([])
  await $.prompt.submit({ text: 'Continue', origin: { kind: 'auto-continuation' }, wait: false } as never)
  expect(r.compactions).toHaveLength(0)
  expect(r.events).toEqual(['prompt:auto-continuation'])
  expect(await stored($, r, KEY)).toBeUndefined()
})

test('native mode: a prompt from the person drops the note as well', async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)], tokens: 400_000 })
  await halt($)
  await typed($, 'I am back')
  expect(await stored($, r, KEY)).toBeUndefined()
  expect(r.compactions).toHaveLength(0)
})
