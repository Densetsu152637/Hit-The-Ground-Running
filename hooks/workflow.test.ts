import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { chunk, ENTRY_MAX } from './logic'
import { rig } from './harness'

const ROOT = 'D:/Work/Workflow'
const USER_MD = 'C:/Users/me/.claude/CLAUDE.md'
const ON = { workflowDir: String.raw`D:\Work\Workflow\ `.trim() } as const
const OFF = { userInstructions: 'off' } as const
const ROOT_MD = '# Root\n\nLoad the [delegation default](root-delegation.md#delegation-default) and [index](../personalities/README.md).'
const AGENTS_MD = '# Agent instructions\n\nAt intake load the [root workflow](workflows/AGENTS.root.md). See [process cleanup](#process-cleanup).'
const CLAUDE_MD = '@AGENTS.md\n\nUnder Claude Code, root loads the [Claude Code section](guides/host-adapters.md#claude-code).'
// The user's own file imports the workflow's CLAUDE.md, its path's space escaped, and names a personality.
const USER = String.raw`@D:/Work/My\ Workflow/CLAUDE.md` + '\n\nPersonality: luxion.md\nAlways answer in British English.'

const files = (on: On, extra: Record<string, string> = {}, root = ROOT) => {
  const fs: Record<string, string> = {
    [`${root}/workflows/AGENTS.root.md`]: ROOT_MD,
    [`${root}/AGENTS.md`]: AGENTS_MD,
    [`${root}/CLAUDE.md`]: CLAUDE_MD,
    [USER_MD]: USER,
    ...extra,
  }
  on('fs.read', (_$, e) => {
    // The engine hands the path in the platform's form: compare with forward slashes.
    const path = e.path.replace(/\\/g, '/')
    if (!(path in fs)) throw new Error(`ENOENT ${path}`)
    return { value: fs[path] } as never
  })
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? String.raw`C:\Users\me` : undefined }) as never)
  on('classic.SessionStart', () => ({}) as never)
  return fs
}

const start = async ($: Engine, source: string): Promise<string[]> =>
  ((await $.classic.SessionStart({ source } as never)) as { additionalContext?: string[] }).additionalContext ?? []

const count = (text: string | undefined, part: string): number => (text ?? '').split(part).length - 1

test('loader: with no workflow, the user\'s CLAUDE.md is handed over at every start, imports expanded', async ($, on) => {
  files(on, { [USER_MD]: '@notes.md\nAlways answer in British English.', 'C:/Users/me/.claude/notes.md': 'Never push to main.' })
  await rig($, on)
  const [fresh] = await start($, 'startup')
  expect(fresh).toContain('Follow them from your first action')
  expect(fresh).toContain(`===== ${USER_MD} (imports expanded) =====`)
  expect(fresh).toContain('Never push to main.')
  expect(fresh).toContain('Always answer in British English.')
  expect(fresh).not.toContain('MANDATORY FIRST ACTION')
  const [compacted] = await start($, 'compact')
  expect(compacted).toContain('Context was compacted')
  expect(compacted).toContain('Never push to main.')
})

test('loader: userInstructions off and no workflow hands over nothing', { options: OFF }, async ($, on) => {
  files(on)
  await rig($, on)
  expect(await start($, 'startup')).toEqual([])
})

test('loader: no user CLAUDE.md and no workflow hands over nothing', async ($, on) => {
  const fs = files(on)
  delete fs[USER_MD]
  await rig($, on)
  expect(await start($, 'startup')).toEqual([])
})

test('workflow: a fresh start carries the user\'s file, the workflow\'s CLAUDE.md through it, and the root workflow', { options: { workflowDir: 'D:/Work/My Workflow' } }, async ($, on) => {
  const root = 'D:/Work/My Workflow'
  files(on, {}, root)
  await rig($, on)
  const entries = await start($, 'startup')
  expect(entries).toHaveLength(2)
  const [lead, rootEntry] = entries
  expect(lead).toContain('MANDATORY FIRST ACTION')
  expect(lead).toContain(`${root}/personalities/luxion.md`)
  expect(lead).toContain(`===== ${USER_MD} (imports expanded) =====`)
  // The user's import of the workflow's CLAUDE.md is expanded once, and that file's own import with it.
  expect(lead).not.toContain('@D:/Work')
  expect(count(lead, '# Agent instructions')).toBe(1)
  expect(lead).not.toContain('imported by the workflow loader')
  expect(lead).toContain('Always answer in British English.')
  expect(lead).toContain(`](${root}/workflows/AGENTS.root.md)`)
  expect(lead).toContain(`](${root}/guides/host-adapters.md#claude-code)`)
  expect(lead).toContain('](#process-cleanup)')
  expect(rootEntry).toContain(`===== ${root}/workflows/AGENTS.root.md =====`)
  expect(rootEntry).toContain(`](${root}/workflows/root-delegation.md#delegation-default)`)
  expect(rootEntry).toContain(`](${root}/personalities/README.md)`)
})

test('workflow: a user file that does not import the workflow gets its CLAUDE.md added', { options: ON }, async ($, on) => {
  files(on)
  await rig($, on)
  const [lead] = await start($, 'startup')
  expect(lead).toContain('Always answer in British English.')
  expect(lead).toContain(`(${ROOT}/CLAUDE.md, imported by the workflow loader)`)
  expect(count(lead, '# Agent instructions')).toBe(1)
})

test('workflow: a compaction or resume asks for a re-read and a restored checkpoint', { options: ON }, async ($, on) => {
  files(on)
  await rig($, on)
  const [compacted, rootEntry] = await start($, 'compact')
  expect(compacted).toContain('Context was compacted')
  expect(compacted).toContain('restored checkpoint')
  expect(compacted).toContain('# Agent instructions')
  expect(rootEntry).toContain(`===== ${ROOT}/workflows/AGENTS.root.md =====`)
  expect((await start($, 'resume'))[0]).toContain('Context was resumed')
})

test('workflow: with userInstructions off, the workflow still comes, its CLAUDE.md included', { options: { ...ON, ...OFF } }, async ($, on) => {
  files(on)
  await rig($, on)
  const [lead, rootEntry] = await start($, 'startup')
  expect(lead).not.toContain('Always answer in British English.')
  expect(lead).toContain('# Agent instructions')
  expect(rootEntry).toContain('AGENTS.root.md')
})

test('workflow: an unreadable root workflow still tells the model to read it', { options: { workflowDir: 'D:/Nowhere' } }, async ($, on) => {
  files(on)
  await rig($, on)
  const entries = await start($, 'startup')
  expect(entries.some(t => t.includes('D:/Nowhere/workflows/AGENTS.root.md could not be read'))).toBe(true)
})

test('workflow: the personality falls back to the workflow\'s own CLAUDE.md', { options: ON }, async ($, on) => {
  files(on, { [USER_MD]: 'No personality here.', [`${ROOT}/CLAUDE.md`]: 'Personality: yoda.md' })
  await rig($, on)
  expect((await start($, 'startup'))[0]).toContain(`${ROOT}/personalities/yoda.md`)
})

test('workflow: an import that cannot be read stays named in place; a cycle is expanded once', { options: ON }, async ($, on) => {
  const fs = files(on, { [USER_MD]: 'Mine.', [`${ROOT}/CLAUDE.md`]: '@AGENTS.md\n@missing.md\n@CLAUDE.md' })
  fs[`${ROOT}/AGENTS.md`] = `${AGENTS_MD}\n@CLAUDE.md`
  await rig($, on)
  const [lead] = await start($, 'startup')
  expect(lead).toContain(`@missing.md (could not be read here: read ${ROOT}/missing.md yourself)`)
  expect(count(lead, '# Agent instructions')).toBe(1)
})

test('loader: a long CLAUDE.md is split into entries under the host\'s limit, at line ends', async ($, on) => {
  const long = Array.from({ length: 600 }, (_, i) => `Rule ${i}: ${'keep it tidy '.repeat(3)}`).join('\n')
  files(on, { [USER_MD]: long })
  await rig($, on)
  const entries = await start($, 'startup')
  expect(entries.length).toBeGreaterThan(1)
  for (const e of entries) expect(e.length).toBeLessThanOrEqual(ENTRY_MAX)
  expect(entries.join('\n')).toContain('Rule 599:')
  expect(chunk('a\nb', 1)).toEqual(['a', 'b'])
})
