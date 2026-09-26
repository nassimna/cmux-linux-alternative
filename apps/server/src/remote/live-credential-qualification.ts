import type { LiveCredentialOriginStore } from './live-credential-origin'

type ExistingTarget = Readonly<{ remoteTargetId: string; revision: number }>
type LegacyPresence = Readonly<{
  probeRustCredentialForCutover(targetId: string): Promise<boolean>
}>

/**
 * Classify an inherited Rust credential only after the live database writer fence
 * has transferred to Node. The provider checks that fence before each exact v1
 * SearchItems request. No secret bytes are read or copied here.
 */
export async function qualifyLiveCredentialOrigins(
  targets: readonly ExistingTarget[],
  origins: Pick<LiveCredentialOriginStore, 'read' | 'markV1Eligible'>,
  provider: LegacyPresence
): Promise<{ eligible: number; missing: readonly string[] }> {
  if (targets.length > 128) throw new Error('Live remote target catalog exceeds the Rust bound')
  const ids = new Set<string>()
  const missing: string[] = []
  let eligible = 0
  for (const target of targets) {
    if (ids.has(target.remoteTargetId)) throw new Error('Duplicate live remote target')
    ids.add(target.remoteTargetId)
    const origin = origins.read(target.remoteTargetId)
    if (origin === 'v2_committed') continue
    if (origin === 'v1_eligible') {
      eligible++
      continue
    }
    if (!(await provider.probeRustCredentialForCutover(target.remoteTargetId))) {
      missing.push(target.remoteTargetId)
      continue
    }
    origins.markV1Eligible(target.remoteTargetId, target.revision)
    eligible++
  }
  return { eligible, missing }
}
