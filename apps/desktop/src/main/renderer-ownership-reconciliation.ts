import type { ApplicationSnapshot } from '@agent-workspace/protocol-client'

/** Collects native terminal/browser resources from one authoritative window projection. */
export function runtimeResourceIds(snapshot: ApplicationSnapshot): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const workspace of snapshot.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.content.kind === 'terminal' && tab.content.runtimeSessionId) {
        ids.add(tab.content.runtimeSessionId)
      } else if (tab.content.kind === 'browser') {
        ids.add(tab.content.state.browserSessionId)
      }
    }
  }
  return ids
}
