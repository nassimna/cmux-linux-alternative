import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('desktop update build configuration', () => {
  it('packages the trusted GitHub feed and retains explicit generic feed builds', () => {
    const builder = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(builder).not.toContain('${env.')
    expect(builder).toMatch(/^publish:/mu)
    expect(builder).toContain('provider: github')
    expect(builder).toContain('owner: nassimna')
    expect(builder).toContain('repo: cmux-linux-alternative')
    expect(builder).toMatch(/electronUpdaterCompatibility: ['"]>= 2\.16['"]/u)
    expect(manifest.scripts['package:linux']).not.toContain('publish.provider')
    expect(manifest.scripts['package:linux']).toContain('--publish never')
    expect(manifest.scripts['package:linux:dir']).not.toContain('publish.provider')
    expect(manifest.scripts['package:linux:dir']).toContain('--publish never')
    expect(manifest.scripts['package:linux:updates']).toContain('package-native-updates.mjs linux')
    expect(manifest.scripts['package:mac:updates']).toContain('package-native-updates.mjs mac')
    expect(manifest.scripts['package:windows:updates']).toContain(
      'package-native-updates.mjs windows'
    )
  })
})
