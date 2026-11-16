import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { rig } from './harness'

const ROOT = 'D:/Work/Workflow'
const ON = { workflowDir: String.raw`D:\Work\Workflow\ `.trim() } as const
const ROOT_MD = '# Root\n\nLoad the [delegation default](root-delegation.md#delegation-default) and [index](../personalities/README.md).'

const files = (on: On, extra: Record<string, string> = {}) => {
  const fs: Record<string, string> = {
    [`${ROOT}/workflows/AGENTS.root.md`]: ROOT_MD,
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
  const [text] = await start($, 'startup')
  expect(text).toContain('MANDATORY FIRST ACTION')
  expect(text).toContain(`${ROOT}/personalities/luxion.md`)
  expect(text).toContain(`](${ROOT}/workflows/root-delegation.md#delegation-default)`)
  expect(text).toContain(`](${ROOT}/personalities/README.md)`)
  expect((await start($, 'clear'))[0]).toContain('MANDATORY FIRST ACTION')
})

test('workflow: a compaction or resume asks for a re-read and a restored checkpoint', { options: ON }, async ($, on) => {
  files(on)
  await rig($, on)
  const [compacted] = await start($, 'compact')
  expect(compacted).toContain('Context was compacted')
  expect(compacted).toContain('restored checkpoint')
  expect(compacted).toContain('===== D:/Work/Workflow/workflows/AGENTS.root.md =====')
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
