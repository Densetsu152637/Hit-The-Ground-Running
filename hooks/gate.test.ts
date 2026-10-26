import { expect, test } from 'claude-code/testing'

import { AGENT_CALL, HOUR, NOW, SPAWN, five, measure, rig, spawns, week } from './harness'

const reset5 = NOW + 3 * HOUR

test('gate: while open, the Agent tool and spawns pass to the engine', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(60, reset5)])
  const call = await $.tool.call(AGENT_CALL as never)
  expect(call).not.toHaveProperty('deny')
  await $.agent.spawn(SPAWN as never)
  expect(seen.agentCalls).toBe(1)
  expect(seen.spawned).toBe(1)
})

test('gate: while closed, a new Agent call and a new spawn are denied with the reason; nothing reaches the engine', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(86, reset5)])
  const call = (await $.tool.call(AGENT_CALL as never)) as { deny?: string; text?: string; isError?: boolean }
  expect(JSON.stringify(call)).toContain('Agent-pool usage gate is closed')
  expect(JSON.stringify(call)).toContain('5-hour usage 86%')
  const spawn = (await $.agent.spawn(SPAWN as never)) as { deny?: string }
  expect(spawn.deny).toContain('spawn no new subagents')
  expect(seen.agentCalls).toBe(0)
  expect(seen.spawned).toBe(0)
})

test('gate: running agents keep going: SendMessage and a resumed spawn are not blocked while closed', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [week(96, NOW + 48 * HOUR)])
  await $.tool.call({ tool: 'SendMessage', to: 'a1', message: 'Next: the docs.' } as never)
  const resumed = (await $.agent.spawn({ ...SPAWN, resume: { agentId: 'a1' } } as never)) as { deny?: string }
  expect(resumed.deny).toBeUndefined()
  expect(seen.sendCalls).toBe(1)
  expect(seen.spawned).toBe(1)
})

test('gate: it reopens once the window resets, so spawns pass again', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(90, NOW + 2 * HOUR)])
  r.usage.rateLimits = [five(2, NOW + 7 * HOUR)]
  await r.clock.advance(2 * HOUR + 60_000)
  await $.tool.call(AGENT_CALL as never)
  expect(seen.agentCalls).toBe(1)
})

test('gate: a hook that fails is denied only while the gate is closed (the .catch fails closed only then)', async ($, on) => {
  const seen = spawns(on)
  const r = await rig($, on)
  await measure($, r, [five(60, reset5)])
  // Usage unreadable while the gate is open: fail open, the call goes through.
  r.failUsage = true
  await $.tool.call(AGENT_CALL as never)
  await $.agent.spawn(SPAWN as never)
  expect(seen.agentCalls).toBe(1)
  expect(seen.spawned).toBe(1)

  r.failUsage = false
  await measure($, r, [five(88, reset5)])
  // Usage unreadable while the gate is closed: the handler denies in the hook's place.
  r.failUsage = true
  const call = await $.tool.call(AGENT_CALL as never)
  const spawn = (await $.agent.spawn(SPAWN as never)) as { deny?: string }
  expect(JSON.stringify(call)).toContain('gate is closed')
  expect(spawn.deny).toContain('gate is closed')
  expect(seen.agentCalls).toBe(1)
  expect(seen.spawned).toBe(1)
})
