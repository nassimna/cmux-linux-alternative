import { describe, expect, it } from 'vitest'

import { CredentialReference, UnavailableCredentialProvider } from './credential-provider'
import { exactCredentialMatch, exactCredentialPresence } from './credential-secret-service'
import { verifyRemoteTarget } from './ssh-launch-plan'
import { isNoTmuxServerResponse, parseTmuxSessions, parseTmuxVersion, tmuxCommand } from './tmux-protocol'

const targetId = '123e4567-e89b-42d3-a456-426614174000'

describe('contained remote transport foundation', () => {
  it('fails closed while a trusted signing provider is absent', async () => {
    const provider = new UnavailableCredentialProvider()
    await expect(
      provider.acquire(CredentialReference.forTarget(targetId), targetId, 1, 'unused-pinned-host-key')
    ).rejects.toMatchObject({
      code: 'credential_provider_unavailable'
    })
  })

  it('rejects locked and duplicate Secret Service matches', () => {
    expect(exactCredentialMatch(['/one'], [])).toBe('/one')
    expect(() => exactCredentialMatch(['/one'], ['/locked'])).toThrowError(
      'An unlocked credential is required'
    )
    expect(() => exactCredentialMatch(['/one', '/two'], [])).toThrowError(
      'Credential is ambiguous or invalid'
    )
    expect(() => exactCredentialMatch([], [])).toThrowError('An unlocked credential is required')
    expect(exactCredentialPresence(['/one'], [])).toBe('present')
    expect(exactCredentialPresence([], [])).toBe('missing')
    expect(exactCredentialPresence(['/one'], ['/locked'])).toBe('locked')
    expect(exactCredentialPresence(['/one', '/two'], [])).toBe('duplicate')
    expect(() => exactCredentialPresence('invalid', [])).toThrowError(
      'Trusted credential provider is unavailable'
    )
  })

  it('rejects caller-fabricated host trust and shell metacharacters', () => {
    const fakeProof = {
      remoteTargetId: targetId,
      targetRevision: 1,
      host: 'example.org',
      port: 22,
      knownHostsPath: '/tmp/known_hosts',
      descriptor: {}
    } as never
    expect(() =>
      verifyRemoteTarget({ proof: fakeProof, generation: 1, user: 'nassim', knownHostsVersion: 1 })
    ).toThrowError('host key untrusted')
    expect(() => tmuxCommand({ kind: 'attach', name: 'work;id' })).toThrowError('invalid target')
  })

  it('bounds tmux discovery and enforces version 3.2', () => {
    expect(() => parseTmuxVersion(Buffer.from('tmux 3.2a\n'))).not.toThrow()
    expect(() => parseTmuxVersion(Buffer.from('tmux 3.1\n'))).toThrowError(
      'tmux 3.2 or newer is required'
    )
    expect(parseTmuxSessions(Buffer.from('one\ntwo\n'))).toEqual(['one', 'two'])
    expect(() => parseTmuxSessions(Buffer.from('bad;name\n'))).toThrowError('invalid tmux response')
    expect(() => parseTmuxSessions(Buffer.alloc(64 * 1024 + 1))).toThrowError(
      'invalid tmux response'
    )
  })

  it('recognizes only stock no-server diagnostics as an empty session list', () => {
    expect(isNoTmuxServerResponse('no server running on /tmp/tmux-1000/default\n')).toBe(true)
    expect(
      isNoTmuxServerResponse('error connecting to /tmp/tmux-1000/default (No such file or directory)\n')
    ).toBe(true)
    expect(isNoTmuxServerResponse('Permission denied (publickey).\n')).toBe(false)
    expect(isNoTmuxServerResponse('error connecting to /tmp/other (Permission denied)\n')).toBe(false)
  })
})
