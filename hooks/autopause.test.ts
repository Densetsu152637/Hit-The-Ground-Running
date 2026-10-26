import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { HOUR, MIN, NOW, SID, five, measure, rig, runCommand, stored, typed } from './harness'

const RESUME_TEXT = 'Usage limits reset (Hit The Ground Running). Continue where you stopped; re-check the agent-pool usage gate before spawning. If a limit is hit again, stop.'
const KEY = `resume:${SID}`
const reset5 = NOW + 2 * HOUR

type Saved = { resetsAt: number; fireAt: number; reason: string; owner: string }

const begin = async ($: Engine, turnId = 't1') => {
  await $.turn.start({ text: 'go', turnId } as never)
}
const end = async ($: Engine, turnId = 't1') => {
  await $.turn.complete({ turnId, reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as never)
}

test('auto-pause: a running turn at 90% 5-hour usage is stopped and resumed after the reset (default option)', async ($, on) => {
  const r = await rig($, on)
  await begin($)
  await measure($, r, [five(89, reset5)])
  expect(r.aborts).toEqual([])
  await measure($, r, [five(90, reset5)])
  expect(r.aborts).toEqual(['t1'])
  const saved = (await stored($, r, KEY)) as Saved
  expect(saved).toMatchObject({ resetsAt: reset5, reason: 'pause', owner: 'mod' })
  expect(r.toasts.some(t => t.includes('auto-paused at 90%'))).toBe(true)
  await end($)
  await r.clock.advance(2 * HOUR + 91_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('auto-pause: an idle session is not paused; it pauses once it starts working in the same period', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(92, reset5)])
  expect(await stored($, r, KEY)).toBeUndefined()
  await begin($, 't2')
  await measure($, r, [five(93, reset5)])
  expect(r.aborts).toEqual(['t2'])
})

test('auto-pause: once per period: typing after the pause overrides it until the next reset', async ($, on) => {
  const r = await rig($, on)
  await begin($)
  await measure($, r, [five(91, reset5)])
  await end($)
  await typed($)
  expect(await stored($, r, KEY)).toBeUndefined()
  await begin($, 't3')
  await measure($, r, [five(95, reset5)])
  expect(r.aborts).toEqual(['t1'])
  // The next 5-hour period pauses again.
  await end($, 't3')
  const next5 = reset5 + 5 * HOUR
  await r.clock.advance(3 * HOUR)
  await begin($, 't4')
  await measure($, r, [five(90, next5)])
  expect(r.aborts).toEqual(['t1', 't4'])
})

test('auto-pause: the period already paused survives a reload', async ($, on) => {
  const r = await rig($, on, { store: { [`tiers:${SID}`]: { tiers: {}, gated: true, pausedFor: reset5 } } })
  await begin($)
  await measure($, r, [five(96, reset5)])
  expect(r.aborts).toEqual([])
})

test('auto-pause: off disables it and /htgr shows the option', { options: { autoPause: 'off' } }, async ($, on) => {
  const r = await rig($, on)
  await begin($)
  await measure($, r, [five(99, reset5)])
  expect(r.aborts).toEqual([])
  expect(await runCommand($, 'htgr')).toContain('autoPause=off')
})

test('auto-pause: a custom tier is honoured', { options: { autoPause: '95' } }, async ($, on) => {
  const r = await rig($, on)
  await begin($)
  await measure($, r, [five(94, reset5)])
  expect(r.aborts).toEqual([])
  await measure($, r, [five(95, reset5)])
  expect(r.aborts).toEqual(['t1'])
  expect(Math.abs(((await stored($, r, KEY)) as Saved).fireAt - reset5)).toBeLessThan(2 * MIN)
})
