import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { rig } from './harness'

const ROOT = 'D:/Work/Workflow'
const ON = { workflowDir: String.raw`D:\Work\Workflow\ `.trim() } as const
const ROOT_MD = '# Root\n\nLoad the [delegation default](root-delegation.md#delegation-default) and [index](../personalities/README.md).'

const AGENTS_MD = '# Agent instructions\n\nAt intake load the [root workflow](workflows/AGENTS.root.md). See [process cleanup](#process-cleanup).'

const CLAUDE_MD = '@AGENTS.md\n\nUnder Claude Code, root loads the [Claude Code section](guides/host-adapters.md#claude-code).'

const files = (on: On, extra: Record<string, string> = {}) => {
  const fs: Record<string, string> = {
    [`${ROOT}/workflows/AGENTS.root.md`]: ROOT_MD,
    [`${ROOT}/AGENTS.md`]: AGENTS_MD,
    [`${ROOT}/CLAUDE.md`]: CLAUDE_MD,
    'C:/Users/me/.claude/CLAUDE.md': '@imports\n\nPersonality: luxion.md\n',
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

test('workflow: a fresh start mandates the intake reads and carries the root workflow with absolute links', { options: ON }, async ($, on) => {
  files(on)
  await rig($, on)
  const entries = await start($, 'startup')
  // Two entries, so neither passes the host's limit on one: the lead with CLAUDE.md, then the root workflow.
  expect(entries).toHaveLength(2)
  const [lead, rootEntry] = entries
  expect(lead).toContain('MANDATORY FIRST ACTION')
  expect(lead).toContain(`${ROOT}/personalities/luxion.md`)
  expect(lead).toContain(`===== ${ROOT}/CLAUDE.md (imports expanded) =====`)
  // `@AGENTS.md` is replaced by its text, and CLAUDE.md's own lines follow.
  expect(lead).not.toContain('@AGENTS.md')
  expect(lead).toContain('# Agent instructions')
  expect(lead).toContain(`](${ROOT}/workflows/AGENTS.root.md)`)
  expect(lead).toContain(`](${ROOT}/guides/host-adapters.md#claude-code)`)
  // An anchor within AGENTS.md stays as it is.
  expect(lead).toContain('](#process-cleanup)')
  expect(rootEntry).toContain(`](${ROOT}/workflows/root-delegation.md#delegation-default)`)
  expect(rootEntry).toContain(`](${ROOT}/personalities/README.md)`)
  expect((await start($, 'clear'))[0]).toContain('MANDATORY FIRST ACTION')
})

test('workflow: a compaction or resume asks for a re-read and a restored checkpoint', { options: ON }, async ($, on) => {
  files(on)
  await rig($, on)
  const [compacted, rootEntry] = await start($, 'compact')
  expect(compacted).toContain('Context was compacted')
  expect(compacted).toContain('restored checkpoint')
  expect(compacted).toContain('===== D:/Work/Workflow/CLAUDE.md (imports expanded) =====')
  expect(compacted).toContain('# Agent instructions')
  expect(rootEntry).toContain('===== D:/Work/Workflow/workflows/AGENTS.root.md =====')
  expect((await start($, 'resume'))[0]).toContain('Context was resumed')
})

test('workflow: off by default', async ($, on) => {
  files(on)
  await rig($, on)
  expect(await start($, 'startup')).toEqual([])
})

test('workflow: an unreadable root workflow still tells the model to read it', { options: { workflowDir: 'D:/Nowhere' } }, async ($, on) => {
  files(on)
  await rig($, on)
  const [text] = await start($, 'startup')
  expect(text).toContain('D:/Nowhere/workflows/AGENTS.root.md could not be read')
})

test('workflow: the personality falls back to the workflow\'s own CLAUDE.md', { options: ON }, async ($, on) => {
  const fs = files(on, { [`${ROOT}/CLAUDE.md`]: 'Personality: yoda.md' })
  delete fs['C:/Users/me/.claude/CLAUDE.md']
  await rig($, on)
  expect((await start($, 'startup'))[0]).toContain(`${ROOT}/personalities/yoda.md`)
})

test('workflow: an unreadable CLAUDE.md is named for the model to read; the root workflow still comes', { options: ON }, async ($, on) => {
  const fs = files(on)
  delete fs[`${ROOT}/CLAUDE.md`]
  await rig($, on)
  const entries = await start($, 'startup')
  expect(entries[1]).toContain('===== D:/Work/Workflow/workflows/AGENTS.root.md =====')
  expect(entries.at(-1)).toContain(`${ROOT}/CLAUDE.md could not be read`)
})

test('workflow: an import that cannot be read stays named in place; a cycle is expanded once', { options: ON }, async ($, on) => {
  const fs = files(on, { [`${ROOT}/CLAUDE.md`]: '@AGENTS.md\n@missing.md\n@CLAUDE.md' })
  fs[`${ROOT}/AGENTS.md`] = `${AGENTS_MD}\n@CLAUDE.md`
  await rig($, on)
  const [lead] = await start($, 'startup')
  expect(lead).toContain(`@missing.md (could not be read here: read ${ROOT}/missing.md yourself)`)
  expect(lead?.split('# Agent instructions').length).toBe(2)
})
