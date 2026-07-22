import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createReleaseManifest, verifyReleaseManifest } from './release-artifacts.mjs'

const version = '1.2.3-beta.1'

test('creates a deterministic manifest and independently verifies all release artifacts', async () => {
  await withReleaseDirectory(async (directory) => {
    const first = await createReleaseManifest({ releaseDirectory: directory, version })
    const second = await createReleaseManifest({ releaseDirectory: directory, version })
    assert.deepEqual(first.artifacts, second.artifacts)
    await verifyReleaseManifest({ releaseDirectory: directory, version })
  })
})

test('rejects artifact tampering and unexpected primary artifacts', async () => {
  await withReleaseDirectory(async (directory) => {
    await createReleaseManifest({ releaseDirectory: directory, version })
    await writeFile(join(directory, `agent-workspace-${version}-x86_64.deb`), 'tampered')
    await assert.rejects(
      verifyReleaseManifest({ releaseDirectory: directory, version }),
      /Checksum mismatch/u
    )
    await writeFile(join(directory, 'unapproved.rpm'), 'extra')
    await assert.rejects(
      createReleaseManifest({ releaseDirectory: directory, version }),
      /must contain exactly/u
    )
  })
})

test('rejects symlinked artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-release-artifacts-'))
  try {
    await writeFile(join(directory, 'target'), 'not an artifact')
    for (const extension of ['AppImage', 'deb', 'rpm']) {
      const name = `agent-workspace-${version}-x86_64.${extension}`
      if (extension === 'rpm') await symlink('target', join(directory, name))
      else await writeFile(join(directory, name), extension)
    }
    await assert.rejects(
      createReleaseManifest({ releaseDirectory: directory, version }),
      /regular file/u
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function withReleaseDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-workspace-release-artifacts-'))
  try {
    for (const extension of ['AppImage', 'deb', 'rpm']) {
      await writeFile(
        join(directory, `agent-workspace-${version}-x86_64.${extension}`),
        `fixture-${extension}`
      )
    }
    await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
