import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { PrivateCodexProfile } from './private-codex-profile'

it('creates an owner-only Codex home bound to one isolated working database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-codex-home-'))
  const sourceRoot = join(root, 'source')
  const workingRoot = join(root, 'working')
  const liveHome = join(root, 'live-codex')
  const source = join(sourceRoot, 'state.sqlite3')
  const working = join(workingRoot, 'state.sqlite3')
  try {
    await Promise.all([
      mkdir(sourceRoot, { mode: 0o700 }),
      mkdir(workingRoot, { mode: 0o700 }),
      mkdir(liveHome, { mode: 0o700 })
    ])
    await Promise.all([
      writeFile(source, 'source', { mode: 0o600 }),
      writeFile(working, 'working', { mode: 0o600 }),
      writeFile(join(liveHome, 'auth.json'), 'live credential sentinel', { mode: 0o600 })
    ])

    const profile = await PrivateCodexProfile.prepare(source, working, liveHome)
    expect(profile.home).toBe(join(workingRoot, 'codex-profile'))
    expect((await stat(profile.home)).mode & 0o777).toBe(0o700)
    expect(await readdir(profile.home)).toEqual(['.agent-workspace-profile.json'])
    expect(await readFile(join(liveHome, 'auth.json'), 'utf8')).toBe('live credential sentinel')
    expect(await PrivateCodexProfile.prepare(source, working, liveHome)).toHaveProperty(
      'home',
      profile.home
    )
    await expect(PrivateCodexProfile.prepare(source, working, profile.home)).rejects.toThrow(
      'overlaps the inherited Codex home'
    )

    const threadId = '10000000-0000-4000-8000-000000000001'
    const year = join(profile.home, 'sessions', '2026')
    const month = join(year, '09')
    const day = join(month, '25')
    for (const path of [join(profile.home, 'sessions'), year, month, day]) {
      await mkdir(path, { mode: 0o700 })
    }
    const threadPath = join(day, `rollout-2026-09-25T00-00-00-${threadId}.jsonl`)
    await writeFile(threadPath, '{}\n', { mode: 0o600 })
    const record = profile.findThreadRecord(threadId)
    expect(record?.path).toBe(threadPath)
    expect(record).toBeDefined()
    profile.assertThreadRecord(record!)
    await rename(threadPath, `${threadPath}.old`)
    await writeFile(threadPath, '{}\n', { mode: 0o600 })
    expect(() => profile.assertThreadRecord(record!)).toThrow('changed')

    const marker = join(profile.home, '.agent-workspace-profile.json')
    const markerContents = await readFile(marker)
    await rename(marker, `${marker}.old`)
    await writeFile(marker, markerContents, { mode: 0o600 })
    expect(() => profile.assertCurrent()).toThrow('authority changed')

    const reopened = await PrivateCodexProfile.prepare(source, working, liveHome)
    expect(() => reopened.assertCurrent()).not.toThrow()

    await rename(profile.home, `${profile.home}.old`)
    await mkdir(profile.home, { mode: 0o700 })
    await writeFile(join(profile.home, '.agent-workspace-profile.json'), markerContents, {
      mode: 0o600
    })
    expect(() => reopened.assertCurrent()).toThrow('authority changed')

    const replacedHome = await PrivateCodexProfile.prepare(source, working, liveHome)
    await rename(working, `${working}.old`)
    await writeFile(working, 'another database', { mode: 0o600 })
    expect(() => replacedHome.assertCurrent()).toThrow('authority changed')
  } finally {
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})

it('secures only an exact new fork rollout and rejects malformed or linked records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-workspace-codex-fork-home-'))
  const sourceRoot = join(root, 'source')
  const workingRoot = join(root, 'working')
  const liveHome = join(root, 'live-codex')
  const source = join(sourceRoot, 'state.sqlite3')
  const working = join(workingRoot, 'state.sqlite3')
  try {
    for (const path of [sourceRoot, workingRoot, liveHome]) await mkdir(path, { mode: 0o700 })
    await writeFile(source, 'source', { mode: 0o600 })
    await writeFile(working, 'working', { mode: 0o600 })
    const profile = await PrivateCodexProfile.prepare(source, working, liveHome)
    const day = join(profile.home, 'sessions', '2026', '09', '25')
    for (const path of [
      join(profile.home, 'sessions'),
      join(profile.home, 'sessions', '2026'),
      join(profile.home, 'sessions', '2026', '09'),
      day
    ]) {
      await mkdir(path, { mode: 0o700 })
    }
    const forkId = '10000000-0000-4000-8000-000000000011'
    const forkPath = join(day, `rollout-2026-09-25T00-00-00-${forkId}.jsonl`)
    await writeFile(forkPath, '{}\n', { mode: 0o644 })
    await chmod(forkPath, 0o644)
    expect(() => profile.findThreadRecord(forkId)).toThrow('unsafe')
    expect(profile.secureForkThreadRecord(forkId)).toMatchObject({
      threadId: forkId,
      path: forkPath
    })
    expect((await stat(forkPath)).mode & 0o777).toBe(0o600)
    expect(() => profile.secureForkThreadRecord('not-a-thread-id')).toThrow('Invalid')

    const linkedId = '10000000-0000-4000-8000-000000000012'
    const linkedPath = join(day, `rollout-2026-09-25T00-00-00-${linkedId}.jsonl`)
    await symlink(forkPath, linkedPath)
    expect(() => profile.secureForkThreadRecord(linkedId)).toThrow()
    expect((await stat(forkPath)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
