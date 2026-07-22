import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { atomicWriteSavedLayout, readSavedLayout } from './desktop-ipc'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-layout-file-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('saved-layout main-process files', () => {
  it('reads from one no-follow regular-file handle and enforces the byte cap', async () => {
    const directory = await temporaryDirectory()
    const valid = join(directory, 'valid.json')
    const oversized = join(directory, 'oversized.json')
    await writeFile(valid, '{"formatVersion":1}', 'utf8')
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20))

    await expect(readSavedLayout(valid)).resolves.toBe('{"formatVersion":1}')
    await expect(readSavedLayout(oversized)).rejects.toThrow('exceeds 256 KiB')
  })

  it('refuses a symlink source instead of following it', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'target.json')
    const link = join(directory, 'link.json')
    await writeFile(target, '{}', 'utf8')
    await symlink(target, link)

    await expect(readSavedLayout(link)).rejects.toThrow()
  })

  it('atomically writes regular destinations and refuses selected symlinks', async () => {
    const directory = await temporaryDirectory()
    const destination = join(directory, 'layout.json')
    const target = join(directory, 'target.json')
    const link = join(directory, 'link.json')
    await writeFile(target, 'unchanged', 'utf8')
    await symlink(target, link)

    await atomicWriteSavedLayout(destination, '{"formatVersion":1}\n')
    await expect(readFile(destination, 'utf8')).resolves.toBe('{"formatVersion":1}\n')
    await expect(atomicWriteSavedLayout(link, '{}')).rejects.toThrow('not a regular file')
    await expect(readFile(target, 'utf8')).resolves.toBe('unchanged')
  })
})
