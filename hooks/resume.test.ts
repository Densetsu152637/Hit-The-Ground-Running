import { expect, test } from 'claude-code/testing'

import { HOUR, MIN, NOW, SID, five, halt, measure, rig, runCommand, stored, typed, week } from './harness'

const RESUME_TEXT = 'Usage limits reset (Hit The Ground Running). Continue where you stopped; re-check the agent-pool usage gate before spawning. If a limit is hit again, stop.'
const MOD = { fiveHourResume: 'mod' } as const
const KEY = `resume:${SID}`
const reset5 = NOW + 2 * HOUR

type Saved = { sessionId: string; resetsAt: number; fireAt: number; reason: string; attempts: number; owner: string }

test('halt: a rate_limit stop at a plan cap (at or above the gate tier with a reset ahead) schedules a resume (mod mode) and persists it', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  const saved = (await stored($, r, KEY)) as Saved | undefined
  expect(saved).toBeDefined()
  expect(saved).toMatchObject({ sessionId: SID, resetsAt: reset5, reason: 'rate_limit-5h', attempts: 0, owner: 'mod' })
  // The resume time is the reset plus 30 to 90 seconds of jitter.
  expect(saved!.fireAt - reset5).toBeGreaterThanOrEqual(30_000)
  expect(saved!.fireAt - reset5).toBeLessThanOrEqual(90_000)
  expect(r.statuses.at(-1)).toContain('resume')
  expect(r.toasts.some(t => t.includes('Auto-resume armed'))).toBe(true)
})

test('halt: a stale pre-halt reading below 100% but at the gate tier still counts as a cap', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(88, reset5)] })
  await halt($)
  expect(await stored($, r, KEY)).toMatchObject({ resetsAt: reset5, reason: 'rate_limit-5h' })
})

test('halt: a transient 429 (usage well under the cap) is ignored', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(60, reset5), week(30, NOW + 48 * HOUR)] })
  await halt($)
  expect(await stored($, r, KEY)).toBeUndefined()
  await r.clock.advance(5 * HOUR)
  expect(r.submitted).toEqual([])
})

test('halt: a cap reading whose reset has already passed is not a cap', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, NOW - MIN)] })
  await halt($)
  expect(await stored($, r, KEY)).toBeUndefined()
})

test('halt: errors other than rate_limit never schedule a resume', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($, 'overloaded')
  await halt($, 'server_error')
  expect(await stored($, r, KEY)).toBeUndefined()
})

test('resume: after the reset it submits the labeled resume prompt, once, and clears the schedule', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  await r.clock.advance(2 * HOUR + 29_000)
  expect(r.submitted).toEqual([])
  // The reading is the pre-halt one, frozen; its reset has passed, so the window counts as fresh.
  await r.clock.advance(62_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
  expect(await stored($, r, KEY)).toBeUndefined()
  await r.clock.advance(5 * HOUR)
  expect(r.submitted).toHaveLength(1)
})

test('resume: a toast warns about a minute before it fires', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  // The warning is a minute before the fire time (the reset plus 30 to 90 s): never before the reset minus 60 s.
  await r.clock.advance(2 * HOUR - 61_000)
  expect(r.toasts.some(t => t.includes('Resuming in about a minute'))).toBe(false)
  await r.clock.advance(92_000)
  expect(r.toasts.some(t => t.includes('Resuming in about a minute'))).toBe(true)
})

test('resume: the schedule is re-armed from the store when the session starts again', { options: MOD }, async ($, on) => {
  const fireAt = NOW + HOUR
  const saved: Saved = { sessionId: SID, resetsAt: fireAt - 40_000, fireAt, reason: 'rate_limit-5h', attempts: 0, owner: 'mod' }
  const r = await rig($, on, { store: { [KEY]: { ...saved, haltedAt: NOW - HOUR } }, rateLimits: [five(5, NOW + 5 * HOUR)] })
  expect(r.statuses.at(-1)).toContain('resume')
  await r.clock.advance(HOUR - 1000)
  expect(r.submitted).toEqual([])
  await r.clock.advance(2000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('resume: a schedule that is overdue after a restart fires shortly after the session loads', { options: MOD }, async ($, on) => {
  const saved = { sessionId: SID, resetsAt: NOW - 2 * HOUR, fireAt: NOW - 2 * HOUR + 60_000, reason: 'rate_limit-5h', attempts: 0, owner: 'mod', haltedAt: NOW - 3 * HOUR }
  const r = await rig($, on, { store: { [KEY]: saved } })
  expect(r.submitted).toEqual([])
  await r.clock.advance(11_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('resume: a schedule saved by another session is not armed', { options: MOD }, async ($, on) => {
  const other = { sessionId: 'someone-else', resetsAt: NOW + HOUR, fireAt: NOW + HOUR, reason: 'rate_limit-5h', attempts: 0, owner: 'mod', haltedAt: NOW }
  const r = await rig($, on, { store: { [KEY]: other } })
  await r.clock.advance(2 * HOUR)
  expect(r.submitted).toEqual([])
  expect(await stored($, r, KEY)).toBeUndefined()
})

test('loop guard: usage still at the gate when it fires re-arms for the next reset, at most twice, then gives up', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  // Each time it fires, the window is still at the gate with a new reset ahead.
  let next = reset5 + 3 * HOUR
  r.usage.rateLimits = [five(90, next)]
  await r.clock.advance(2 * HOUR + 91_000)
  expect(r.submitted).toEqual([])
  expect(((await stored($, r, KEY)) as Saved).attempts).toBe(1)
  expect(((await stored($, r, KEY)) as Saved).resetsAt).toBe(next)

  next += 3 * HOUR
  r.usage.rateLimits = [five(90, next)]
  await r.clock.advance(3 * HOUR + 91_000)
  expect(((await stored($, r, KEY)) as Saved).attempts).toBe(2)
  expect(r.submitted).toEqual([])

  r.usage.rateLimits = [five(90, next + 3 * HOUR)]
  await r.clock.advance(3 * HOUR + 91_000)
  expect(r.submitted).toEqual([])
  expect(await stored($, r, KEY)).toBeUndefined()
  expect(r.notified.some(t => t.includes('Not resuming'))).toBe(true)
  expect(r.events).not.toContain('submit')
})

test('safety: a prompt the person types after the halt cancels the resume', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  await typed($, 'actually, do something else')
  expect(await stored($, r, KEY)).toBeUndefined()
  expect(r.toasts.some(t => t.includes('You are back'))).toBe(true)
  await r.clock.advance(3 * HOUR)
  expect(r.submitted).toEqual([])
})

test('safety: machine prompts and the mod commands do not count as the person returning', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  await $.prompt.submit({ text: 'bg task done', origin: { kind: 'task-notification' }, wait: false } as never)
  await $.prompt.submit({ text: '/htgr', origin: { kind: 'composer' }, wait: false, command: { name: 'htgr', args: '' } } as never)
  await $.prompt.submit({ text: 'idle', origin: { kind: 'unclassified' }, wait: false, isMeta: true } as never)
  expect(await stored($, r, KEY)).toBeDefined()
  await r.clock.advance(2 * HOUR + 91_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('safety: /htgr-cancel cancels a pending resume, and /clear forgets it', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  expect(await runCommand($, 'htgr-cancel')).toContain('Cancelled')
  expect(await stored($, r, KEY)).toBeUndefined()
  await r.clock.advance(3 * HOUR)
  expect(r.submitted).toEqual([])
  expect(await runCommand($, 'htgr-cancel')).toContain('Nothing is pending')

  r.usage.rateLimits = [five(99, r.clock.now() + HOUR)]
  await halt($)
  expect(await stored($, r, KEY)).toBeDefined()
  await $.session.end({ reason: 'clear', sessionId: SID, resume: {} } as never)
  expect(await stored($, r, KEY)).toBeUndefined()
})

test('safety: a turn running at fire time defers the resume until the session is idle', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  await $.turn.start({ text: '', turnId: 't1' } as never)
  await r.clock.advance(2 * HOUR + 91_000)
  expect(r.submitted).toEqual([])
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as never)
  await r.clock.advance(31_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('options: native (default) leaves a 5-hour cap to Claude auto-continue: no resume from the mod', async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  expect(await stored($, r, KEY)).toMatchObject({ owner: 'native', reason: 'native-5h' })
  expect(r.toasts.some(t => t.includes('native auto-continue'))).toBe(true)
  await r.clock.advance(3 * HOUR)
  expect(r.submitted).toEqual([])
  expect(r.events).toEqual([])
})

test('options: mod mode resumes a 5-hour cap itself', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5)] })
  await halt($)
  await r.clock.advance(2 * HOUR + 91_000)
  expect(r.submitted).toHaveLength(1)
})

test('options: the weekly cap is resumed by default, by the mod, in native mode too', async ($, on) => {
  const resetWk = NOW + 30 * HOUR
  const r = await rig($, on, { rateLimits: [five(40, reset5), week(99, resetWk)] })
  await halt($)
  expect(await stored($, r, KEY)).toMatchObject({ owner: 'mod', reason: 'rate_limit-weekly', resetsAt: resetWk })
  await r.clock.advance(30 * HOUR + 91_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('options: weeklyResume off leaves a weekly cap alone', { options: { weeklyResume: 'off' } }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(40, reset5), week(99, NOW + 30 * HOUR)] })
  await halt($)
  expect(await stored($, r, KEY)).toBeUndefined()
  await r.clock.advance(31 * HOUR)
  expect(r.submitted).toEqual([])
})

test('pause: /htgr-pause HH:MM schedules a resume at that local time and stops the running turn', async ($, on) => {
  const r = await rig($, on)
  await $.turn.start({ text: 'go', turnId: 't9' } as never)
  const d = new Date(NOW + 2 * HOUR)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const text = await runCommand($, 'htgr-pause', hhmm)
  expect(text).toContain('Stopped the running turn')
  expect(text).toContain('Resume scheduled')
  expect(r.aborts).toEqual(['t9'])
  const saved = (await stored($, r, KEY)) as Saved
  expect(saved.reason).toBe('pause')
  expect(saved.owner).toBe('mod')
  expect(Math.abs(saved.fireAt - (NOW + 2 * HOUR))).toBeLessThan(MIN)
  await $.turn.complete({ turnId: 't9', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as never)
  await r.clock.advance(2 * HOUR + MIN)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('pause: /htgr-pause with no argument waits for the next 5-hour reset, always the mod, even in native mode', async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(50, reset5)] })
  expect(await runCommand($, 'htgr-pause')).toContain('Resume scheduled')
  expect(((await stored($, r, KEY)) as Saved).resetsAt).toBe(reset5)
  await r.clock.advance(2 * HOUR + 91_000)
  expect(r.submitted).toEqual([RESUME_TEXT])
})

test('pause: bad times and an unknown reset are refused without scheduling', async ($, on) => {
  const r = await rig($, on)
  expect(await runCommand($, 'htgr-pause', '25:00')).toContain('not a clock time')
  expect(await runCommand($, 'htgr-pause', 'soon')).toContain('not a time')
  expect(await runCommand($, 'htgr-pause', 'reset')).toContain('No upcoming 5-hour reset')
  expect(await stored($, r, KEY)).toBeUndefined()
})

test('status: /htgr shows readings, the gate, the pending resume and the options', { options: MOD }, async ($, on) => {
  const r = await rig($, on, { rateLimits: [five(99, reset5), week(40, NOW + 48 * HOUR)] })
  await measure($, r, r.usage.rateLimits)
  await halt($)
  const text = await runCommand($, 'htgr')
  expect(text).toContain('5-hour')
  expect(text).toContain('weekly')
  expect(text).toContain('CLOSED')
  expect(text).toContain('resume')
  expect(text).toContain('fiveHourResume=mod')
})
