import { expect, it, vi } from 'vitest'

import { qualifyLiveCredentialOrigins } from './live-credential-qualification'

const first = '00000000-0000-4000-8000-000000000001'
const second = '00000000-0000-4000-8000-000000000002'

it('marks only exact present Rust credentials and leaves missing targets unmarked', async () => {
  const states = new Map<string, 'v1_eligible' | 'v2_committed'>()
  const markV1Eligible = vi.fn((id: string, revision: number) => {
    expect(revision).toBe(4)
    states.set(id, 'v1_eligible')
  })
  const probeRustCredentialForCutover = vi.fn(async (id: string) => id === first)
  const result = await qualifyLiveCredentialOrigins(
    [
      { remoteTargetId: first, revision: 4 },
      { remoteTargetId: second, revision: 4 }
    ],
    { read: (id) => states.get(id) ?? 'unmarked', markV1Eligible },
    { probeRustCredentialForCutover }
  )
  expect(result).toEqual({ eligible: 1, missing: [second] })
  expect(markV1Eligible).toHaveBeenCalledExactlyOnceWith(first, 4)
  expect(probeRustCredentialForCutover).toHaveBeenCalledTimes(2)
})

it('never searches or downgrades a committed v2 origin', async () => {
  const provider = { probeRustCredentialForCutover: vi.fn() }
  const origins = {
    read: () => 'v2_committed' as const,
    markV1Eligible: vi.fn()
  }
  expect(
    await qualifyLiveCredentialOrigins([{ remoteTargetId: first, revision: 5 }], origins, provider)
  ).toEqual({ eligible: 0, missing: [] })
  expect(provider.probeRustCredentialForCutover).not.toHaveBeenCalled()
  expect(origins.markV1Eligible).not.toHaveBeenCalled()
})
