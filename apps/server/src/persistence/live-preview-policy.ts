import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

/** Until desktop cutover is qualified, live ownership is for disposable fixtures only. */
export function assertDisposableLivePreview(path: string, enabled: boolean): void {
  const relativePath = relative(tmpdir(), path)
  const root = relativePath.split(sep)[0]
  if (
    !enabled ||
    !isAbsolute(path) ||
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    !root?.startsWith('agent-workspace-live-')
  ) {
    throw new Error('Live ownership is limited to an explicit disposable preview profile')
  }
}
