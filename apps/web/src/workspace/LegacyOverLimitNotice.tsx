import type { LegacyOverLimitSnapshot } from '@agent-workspace/protocol-client'

export function legacyOverLimitCounts(legacy: LegacyOverLimitSnapshot): string {
  return [
    `workspaces ${String(legacy.workspaceCount)}/128`,
    `maximum panes in one workspace ${String(legacy.maximumPanesInWorkspace)}/64`,
    `maximum tabs in one workspace ${String(legacy.maximumTabsInWorkspace)}/128`,
    `total panes ${String(legacy.totalPaneCount)}/1024`,
    `total tabs ${String(legacy.totalTabCount)}/2048`
  ].join('; ')
}

export function LegacyOverLimitNotice({
  legacy,
  onReviewExports
}: {
  legacy: LegacyOverLimitSnapshot
  onReviewExports?: () => void
}): React.JSX.Element {
  return (
    <section aria-labelledby="legacy-over-limit-title" className="legacy-over-limit" role="alert">
      <strong id="legacy-over-limit-title">Legacy data reduction required</strong>
      <p>Current counts and limits: {legacyOverLimitCounts(legacy)}.</p>
      <p>
        Export important layouts first, then close workspaces, panes, or tabs in the exceeded
        dimensions. Non-increasing changes remain available; reduction mode clears after all counts
        are within their limits and a mutation succeeds.
      </p>
      {onReviewExports ? (
        <button onClick={onReviewExports} type="button">
          Review export options
        </button>
      ) : null}
    </section>
  )
}
