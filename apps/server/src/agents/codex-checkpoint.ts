import { createHash } from 'node:crypto'

import { AgentMutationError } from '../persistence/agent-mutations'

export const CODEX_CHECKPOINT_KIND = 'codex-thread-v1'
export const CODEX_CHECKPOINT_LIFETIME_MS = 30_000

export interface CodexCheckpoint {
  descriptorVersion: 1
  kind: typeof CODEX_CHECKPOINT_KIND
  digestSha256: string
  sizeBytes: 16
  createdAtMs: number
  expiresAtMs: number
}

/** Metadata for an exact thread already verified through the audited Codex app-server. */
export function codexCheckpoint(threadId: string, verifiedAtMs: number): CodexCheckpoint {
  const bytes = Buffer.from(threadId.replaceAll('-', ''), 'hex')
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId) ||
    bytes.length !== 16 ||
    !Number.isSafeInteger(verifiedAtMs) ||
    verifiedAtMs < 0 ||
    verifiedAtMs > Number.MAX_SAFE_INTEGER - CODEX_CHECKPOINT_LIFETIME_MS
  )
    throw new AgentMutationError('invalid_params', 'Codex checkpoint identity is invalid')
  return {
    descriptorVersion: 1,
    kind: CODEX_CHECKPOINT_KIND,
    digestSha256: createHash('sha256').update('codex-thread-v1\0').update(bytes).digest('hex'),
    sizeBytes: 16,
    createdAtMs: verifiedAtMs,
    expiresAtMs: verifiedAtMs + CODEX_CHECKPOINT_LIFETIME_MS
  }
}
