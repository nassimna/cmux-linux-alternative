/** The private resumed copy may add windows, but it must retain the Rust base identities. */
export function matchesNodeCopyBase(
  rust: {
    workspaceIds: readonly string[]
    windowIds: readonly string[]
    selectedWorkspaceId: string | null
  },
  node: {
    workspaceIds: readonly string[]
    windowIds: readonly string[]
    selectedWorkspaceId: string | null
  },
  resume: boolean
): boolean {
  const nodeWorkspaces = new Set(node.workspaceIds)
  const nodeWindows = new Set(node.windowIds)
  if (
    !rust.workspaceIds.every((id) => nodeWorkspaces.has(id)) ||
    !rust.windowIds.every((id) => nodeWindows.has(id))
  )
    return false
  return (
    resume ||
    (rust.workspaceIds.length === nodeWorkspaces.size &&
      rust.windowIds.length === nodeWindows.size &&
      rust.selectedWorkspaceId === node.selectedWorkspaceId)
  )
}
