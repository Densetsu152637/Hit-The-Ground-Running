import { expect, test } from 'claude-code/testing'

import { HOUR, MIN, NOW, five, measure, notes, rig, week } from './harness'

const reset5 = NOW + 3 * HOUR
const resetWk = NOW + 48 * HOUR

test('tiers: one warn note when the 5-hour window crosses 70%, none for the readings after it', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(69, reset5)])
  expect(notes(r)).toEqual([])
  await measure($, r, [five(71, reset5)])
  expect(notes(r)).toHaveLength(1)
  expect(notes(r)[0]).toContain('[Hit The Ground Running] 5-hour usage 71%')
  expect(notes(r)[0]).toContain('Approaching the agent-pool gate')
  await measure($, r, [five(72, reset5)])
  await measure($, r, [five(84.9, reset5)])
  expect(notes(r)).toHaveLength(1)
})

test('tiers: crossing the 5-hour gate at 85% closes it once, with a note, a toast and a status', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(71, reset5)])
  await measure($, r, [five(86, reset5)])
  expect(notes(r)).toHaveLength(2)
  expect(notes(r)[1]).toContain('5-hour usage 86%')
  expect(notes(r)[1]).toContain('Agent-pool gate closed: spawn no new subagents; let running ones finish.')
  await measure($, r, [five(88, reset5)])
  await measure($, r, [five(97, reset5)])
  expect(notes(r)).toHaveLength(2)
  expect(r.toasts.filter(t => t.includes('gate closed'))).toHaveLength(1)
  expect(r.statuses.at(-1)).toContain('gate CLOSED')
})

test('tiers: a jump from below the warn tier to the gate tier gives the gate note alone', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(40, reset5)])
  await measure($, r, [five(90, reset5)])
  expect(notes(r)).toHaveLength(1)
  expect(notes(r)[0]).toContain('gate closed')
})

test('tiers: the weekly window warns at 90% and gates at 95%', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(10, reset5), week(89.9, resetWk)])
  expect(notes(r)).toEqual([])
  await measure($, r, [five(10, reset5), week(90, resetWk)])
  expect(notes(r)).toHaveLength(1)
  expect(notes(r)[0]).toContain('weekly usage 90%')
  await measure($, r, [five(10, reset5), week(95, resetWk)])
  expect(notes(r)).toHaveLength(2)
  expect(notes(r)[1]).toContain('weekly usage 95%')
  expect(notes(r)[1]).toContain('gate closed')
})

test('tiers: when the window resets the gate reopens with one note, and a new period can warn again', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(90, reset5)])
  expect(notes(r)).toHaveLength(1)
  // The reset passes: the timer rechecks the usage, which now reads a fresh window.
  r.usage.rateLimits = [five(3, reset5 + 5 * HOUR)]
  await r.clock.advance(3 * HOUR + MIN)
  const all = notes(r)
  expect(all).toHaveLength(2)
  expect(all[1]).toContain('Agent-pool gate reopened')
  expect(r.toasts.some(t => t.includes('gate reopened'))).toBe(true)
  // The next window warns again at 70%, once.
  await measure($, r, [five(71, reset5 + 5 * HOUR)])
  await measure($, r, [five(73, reset5 + 5 * HOUR)])
  expect(notes(r)).toHaveLength(3)
  expect(notes(r)[2]).toContain('Approaching')
})

test('tiers: a reading frozen from before the reset counts as reset once its time has passed', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(92, NOW + 2 * HOUR)])
  // No new response arrives; the reading stays at 92% but its reset is now in the past.
  await r.clock.advance(2 * HOUR + MIN)
  expect(notes(r).at(-1)).toContain('gate reopened')
  expect(r.statuses.at(-1)).toContain('gate open')
})

test('tiers: tier state survives a reload of the session start, so a note is not repeated', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(90, reset5)])
  expect(notes(r)).toHaveLength(1)
  // The mod reloads: session.start runs again over the same stored tiers.
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  expect(notes(r)).toHaveLength(1)
})
