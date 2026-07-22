import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateRelease } from './validate-release.mjs'

async function fixture(t, { version = '1.2.3', changelog } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'release-validation-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const packagePath = join(directory, 'package.json')
  const desktopPackagePath = join(directory, 'desktop-package.json')
  const changelogPath = join(directory, 'CHANGELOG.md')
  await Promise.all([
    writeFile(packagePath, JSON.stringify({ version })),
    writeFile(
      desktopPackagePath,
      JSON.stringify({
        version,
        homepage: 'https://example.org/agent-workspace/',
        scripts: {
          'release:checksums': `node release-artifacts.mjs create --version ${version}`,
          'release:verify': `node release-artifacts.mjs verify --version ${version}`
        }
      })
    ),
    writeFile(
      changelogPath,
      changelog ?? '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Pending.\n'
    )
  ])
  return { packagePath, desktopPackagePath, changelogPath }
}

test('validates the current unreleased form without git', async (t) => {
  const paths = await fixture(t)
  const result = await validateRelease({ ...paths, version: '1.2.3', mode: 'unreleased' })
  assert.match(result.notes, /Pending/u)
})

test('requires matching package versions, exact tag, and a versioned candidate section', async (t) => {
  const paths = await fixture(t, {
    changelog: '# Changelog\n\n## [1.2.3] - 2026-07-17\n\n### Added\n\n- Release.\n'
  })
  assert.equal(
    (
      await validateRelease({
        ...paths,
        version: '1.2.3',
        mode: 'candidate',
        tag: 'v1.2.3'
      })
    ).prerelease,
    false
  )
  await assert.rejects(
    validateRelease({ ...paths, version: '1.2.3', mode: 'candidate', tag: '1.2.3' }),
    /exactly match/u
  )
  await assert.rejects(
    validateRelease({ ...paths, version: '1.2.4', mode: 'candidate' }),
    /does not match/u
  )
  await writeFile(
    paths.desktopPackagePath,
    JSON.stringify({
      version: '1.2.3',
      homepage: 'https://agent-workspace.invalid/',
      scripts: {
        'release:checksums': 'node release-artifacts.mjs create --version 1.2.3',
        'release:verify': 'node release-artifacts.mjs verify --version 1.2.3'
      }
    })
  )
  await assert.rejects(
    validateRelease({ ...paths, version: '1.2.3', mode: 'candidate' }),
    /public HTTPS URL/u
  )
})

test('rejects malformed versions, duplicate sections, and empty notes', async (t) => {
  const malformed = await fixture(t)
  await assert.rejects(
    validateRelease({ ...malformed, version: '01.2.3', mode: 'unreleased' }),
    /Invalid semantic version/u
  )
  const duplicate = await fixture(t, {
    changelog:
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- One.\n\n## [Unreleased]\n\n### Fixed\n\n- Two.\n'
  })
  await assert.rejects(
    validateRelease({ ...duplicate, version: '1.2.3', mode: 'unreleased' }),
    /Duplicate/u
  )
  const empty = await fixture(t, { changelog: '# Changelog\n\n## [Unreleased]\n\nNothing yet.\n' })
  await assert.rejects(
    validateRelease({ ...empty, version: '1.2.3', mode: 'unreleased' }),
    /must contain/u
  )
})
