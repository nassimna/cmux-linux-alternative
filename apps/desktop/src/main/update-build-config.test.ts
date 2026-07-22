import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

describe('desktop update build configuration', () => {
  it('keeps default packages feed-free and isolates opt-in metadata generation', () => {
    const builder = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(builder).not.toContain('${env.')
    expect(builder).not.toMatch(/^publish:/mu)
    expect(builder).toMatch(/electronUpdaterCompatibility: ['"]>= 2\.16['"]/u)
    expect(manifest.scripts['package:linux']).not.toContain('publish.provider')
    expect(manifest.scripts['package:linux:dir']).not.toContain('publish.provider')
    expect(manifest.scripts['package:linux:updates']).toContain('-c.publish.provider=generic')
    expect(manifest.scripts['package:linux:updates']).toContain('--publish never')
    expect(manifest.scripts['package:linux:updates']).toContain('$AGENT_WORKSPACE_UPDATE_BUILD_URL')
    expect(manifest.scripts['package:linux:updates']).toContain(
      '$AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL'
    )
    expect(manifest.scripts['package:mac:updates']).toContain('package-native-updates.mjs mac')
    expect(manifest.scripts['package:windows:updates']).toContain(
      'package-native-updates.mjs windows'
    )
  })
})
