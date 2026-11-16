import { expect, test } from 'claude-code/testing'

import { AGENT_CALL, HOUR, NOW, SID, SPAWN, five, measure, notes, rig, runCommand, spawns, week } from './harness'

const reset5 = NOW + 3 * HOUR
const resetWk = NOW + 48 * HOUR
const KEY = `gate-off:${SID}`

test('switch: /htgr-gate off opens the closed gate of this session until switched back on', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(86, reset5)])
  const text = await runCommand($, 'htgr-gate', 'off')
  expect(text).toContain('switched off until switched back on')
  expect(r.store[KEY]).toEqual({ until: null, at: NOW })
  expect(notes(r).at(-1)).toContain('The user switched the agent-pool gate off until switched back on')
  expect(r.statuses.at(-1)).toContain('⚪ Gate off')
  const call = await $.tool.call(AGENT_CALL as never)
  expect(call).not.toHaveProperty('deny')
  await $.agent.spawn(SPAWN as never)
  expect(seen.agentCalls).toBe(1)
  expect(seen.spawned).toBe(1)
  // It stays off past the reset, into a new period at the gate tier, with a note that says so.
  r.usage.rateLimits = [five(2, reset5 + 5 * HOUR)]
  await r.clock.advance(3 * HOUR + 60_000)
  await measure($, r, [five(90, reset5 + 5 * HOUR)])
  expect(notes(r).at(-1)).toContain('gate is switched off by the user')
  await $.tool.call(AGENT_CALL as never)
  expect(seen.agentCalls).toBe(2)
})

test('switch: /htgr-gate on closes it again at once when a window is at its gate tier', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(86, reset5)])
  await runCommand($, 'htgr-gate', 'off')
  const text = await runCommand($, 'htgr-gate', 'on')
  expect(text).toContain('switched on and closed')
  expect(r.store[KEY]).toBeUndefined()
  expect(notes(r).at(-1)).toContain('Agent-pool gate closed')
  expect(r.statuses.at(-1)).toContain('🔴 Gate closed')
  const spawn = (await $.agent.spawn(SPAWN as never)) as { deny?: string }
  expect(spawn.deny).toContain('gate is closed')
  expect(seen.spawned).toBe(0)
})

test('switch: no argument toggles; a bad argument is refused', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(40, reset5)])
  expect(await runCommand($, 'htgr-gate')).toContain('switched off')
  expect(await runCommand($, 'htgr-gate')).toContain('switched on')
  expect(await runCommand($, 'htgr-gate', 'on')).toContain('already on')
  expect(await runCommand($, 'htgr-gate', 'later')).toContain('is not a gate setting')
  expect(r.store[KEY]).toBeUndefined()
})

test('switch: /htgr-gate suspend is off until the 5-hour reset, then the gate holds again', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(86, reset5), week(96, resetWk)])
  const text = await runCommand($, 'htgr-gate', 'suspend')
  expect(text).toContain('suspended until')
  expect(r.store[KEY]).toEqual({ until: reset5, at: NOW })
  expect(r.statuses.at(-1)).toContain('⏸ Gate suspended until')
  await $.tool.call(AGENT_CALL as never)
  expect(seen.agentCalls).toBe(1)

  // The 5-hour window resets; the weekly one is still at its gate tier, so the gate closes again.
  r.usage.rateLimits = [five(1, reset5 + 5 * HOUR), week(96, resetWk)]
  await r.clock.advance(3 * HOUR + 60_000)
  expect(r.store[KEY]).toBeUndefined()
  expect(r.toasts.some(t => t.includes('switched back on'))).toBe(true)
  expect(r.statuses.at(-1)).toContain('🔴 Gate closed')
  const call = (await $.tool.call(AGENT_CALL as never)) as { deny?: string }
  expect(JSON.stringify(call)).toContain('gate is closed')
  expect(seen.agentCalls).toBe(1)
})

test('switch: /htgr-gate suspend without a known 5-hour reset is refused', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [week(96, resetWk)])
  expect(await runCommand($, 'htgr-gate', 'suspend')).toContain('No upcoming 5-hour reset')
  expect(r.store[KEY]).toBeUndefined()
})

test('switch: /htgr shows the switch', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(86, reset5)])
  await runCommand($, 'htgr-gate', 'suspend')
  expect(await runCommand($, 'htgr')).toContain('SUSPENDED until')
})

test('switch: when usage runs out the gate suspends itself until the 5-hour reset, in that session', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(90, reset5)])
  await measure($, r, [five(100, reset5)])
  expect(r.store[KEY]).toEqual({ until: reset5, at: NOW, auto: true })
  expect(notes(r).at(-1)).toContain('Agent-pool gate suspended until')
  expect(r.statuses.at(-1)).toContain('⏸ Gate suspended until')
  expect(await runCommand($, 'htgr')).toContain('SUSPENDED automatically')
  await $.tool.call(AGENT_CALL as never)
  expect(seen.agentCalls).toBe(1)
  // The reset passes: the suspension lapses and the gate is on again, open on a fresh window.
  r.usage.rateLimits = [five(1, reset5 + 5 * HOUR)]
  await r.clock.advance(3 * HOUR + 60_000)
  expect(r.store[KEY]).toBeUndefined()
  expect(r.statuses.at(-1)).toContain('🟢 Gate open')
})

test('switch: a manual off is not replaced when usage runs out', async ($, on) => {
  const r = await rig($, on)
  await runCommand($, 'htgr-gate', 'off')
  await measure($, r, [five(100, reset5)])
  expect(r.store[KEY]).toEqual({ until: null, at: NOW })
  expect(r.statuses.at(-1)).toContain('⚪ Gate off (credits)')
})

test('switch: /htgr-gate on after an automatic suspension holds for the rest of that period', async ($, on) => {
  const r = await rig($, on)
  await measure($, r, [five(100, reset5)])
  expect(await runCommand($, 'htgr-gate', 'on')).toContain('switched on')
  expect(r.store[KEY]).toBeUndefined()
  await measure($, r, [five(100, reset5)])
  expect(r.store[KEY]).toBeUndefined()
  expect(r.statuses.at(-1)).toContain('💳 Gate open (credits)')
})

test("switch: another session's switch does not open this session's gate", async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on, { store: { 'gate-off:sess-2': { until: null, at: NOW } } })
  await measure($, r, [five(86, reset5)])
  expect(r.statuses.at(-1)).toContain('🔴 Gate closed')
  const spawn = (await $.agent.spawn(SPAWN as never)) as { deny?: string }
  expect(spawn.deny).toContain('gate is closed')
  expect(seen.spawned).toBe(0)
  expect(r.store['gate-off:sess-2']).toEqual({ until: null, at: NOW })
})

test('switch: the old global switch is dropped on start and does not open the gate', async ($, on) => {
  const r = await rig($, on, { store: { 'gate-off': { until: null, at: NOW }, 'gate-auto-skip': NOW } })
  expect(r.store['gate-off']).toBeUndefined()
  expect(r.store['gate-auto-skip']).toBeUndefined()
  await measure($, r, [five(86, reset5)])
  expect(r.statuses.at(-1)).toContain('🔴 Gate closed')
})

test('switch: the switch ends with the session', async ($, on) => {
  const r = await rig($, on)
  await runCommand($, 'htgr-gate', 'off')
  expect(r.store[KEY]).toEqual({ until: null, at: NOW })
  await $.session.end({ sessionId: SID, reason: 'other' } as never)
  expect(r.store[KEY]).toBeUndefined()
})
