import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export const recoveryEvidenceFileName = 'corrupt-database-recovery-linux.png'

export async function persistRecoveryEvidence(evidenceDirectory, screenshot) {
  if (evidenceDirectory === undefined) return undefined
  if (evidenceDirectory.length === 0 || evidenceDirectory.includes('\0')) {
    throw new Error('AGENT_WORKSPACE_EVIDENCE_DIR must be a non-empty path without NUL bytes.')
  }
  if (!isAbsolute(evidenceDirectory)) {
    throw new Error('AGENT_WORKSPACE_EVIDENCE_DIR must be an absolute path.')
  }

  const normalizedDirectory = resolve(evidenceDirectory)
  const evidencePath = resolve(normalizedDirectory, recoveryEvidenceFileName)
  await mkdir(normalizedDirectory, { recursive: true })
  await writeFile(evidencePath, screenshot, { mode: 0o600 })
  return evidencePath
}
