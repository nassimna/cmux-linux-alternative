export const AUDITED_CODEX_VERSIONS = ['0.142.4', '0.156.1'] as const
export type AuditedCodexVersion = (typeof AUDITED_CODEX_VERSIONS)[number]
const AUDITED_CODEX_FORK_VERSIONS = ['0.142.4', '0.156.1'] as const

export function supportsAuditedCodexFork(version: string): version is AuditedCodexVersion {
  return AUDITED_CODEX_FORK_VERSIONS.some((candidate) => candidate === version)
}
