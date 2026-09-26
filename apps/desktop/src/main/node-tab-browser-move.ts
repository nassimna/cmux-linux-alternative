import type { BrowserViewManager } from './browser-view-manager'

type Descriptor = ReturnType<BrowserViewManager['ownedTransferDescriptors']>[number]

export interface NodeBrowserTabMove {
  source: Pick<BrowserViewManager, 'suspendOwnedSession' | 'destroyOwnedSession'>
  target: Pick<
    BrowserViewManager,
    'ownsSession' | 'mountTransferred' | 'destroyOwnedSession' | 'activateTransferredSession'
  >
  descriptor: Descriptor
  destination: { workspaceId: string; paneId: string }
  assertCurrent(): void
  commit(): Promise<void>
  resolveCommit(): Promise<'committed' | 'not-committed' | 'unknown'>
  transferred(browserSessionId: string): void
  targetSnapshot: Parameters<BrowserViewManager['mountTransferred']>[1]
}

/** Stages a hidden native view before changing its durable tab placement. */
export async function moveNodeBrowserTab(input: NodeBrowserTabMove): Promise<void> {
  const id = input.descriptor.browserSessionId
  input.assertCurrent()
  if (input.target.ownsSession(id)) throw new Error('The target already owns the browser')
  const resume = input.source.suspendOwnedSession(id)
  let staged = false
  const rollback = (): void => {
    input.target.destroyOwnedSession(id)
    resume()
  }
  try {
    input.assertCurrent()
    await input.target.mountTransferred(
      {
        ...input.descriptor,
        ...input.destination
      },
      input.targetSnapshot
    )
    staged = true
    input.assertCurrent()
  } catch (error) {
    rollback()
    throw error
  }

  let commitError: unknown
  try {
    await input.commit()
  } catch (error) {
    const outcome = await input.resolveCommit().catch(() => 'unknown' as const)
    if (outcome === 'not-committed') {
      rollback()
      throw error
    }
    if (outcome === 'unknown') {
      // Neither view may receive input until the service placement is known.
      throw new Error('Node tab move outcome is unknown; native browser transfer is quarantined', {
        cause: error
      })
    }
    commitError = error
  }

  if (staged) {
    input.target.activateTransferredSession(id)
    input.source.destroyOwnedSession(id)
    input.transferred(id)
  }
  if (commitError) throw commitError
}
