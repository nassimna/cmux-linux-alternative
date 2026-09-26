import type { BrowserViewManager } from './browser-view-manager'

type BrowserDescriptor = ReturnType<BrowserViewManager['ownedTransferDescriptors']>[number]

export interface NodeBrowserRehome {
  source: Pick<BrowserViewManager, 'ownedTransferDescriptors' | 'suspendOwnedSession' | 'destroyOwnedSession'>
  target: Pick<BrowserViewManager,
    'ownsSession' | 'mountTransferred' | 'destroyOwnedSession' | 'activateTransferredSession'>
  sourceWorkspaceIds: ReadonlySet<string>
  assertCurrent(): void
  commit(): Promise<void>
  /** Resolve an uncertain HTTP outcome from the authoritative topology. */
  resolveCommit(): Promise<'committed' | 'not-committed' | 'unknown'>
  transferred(browserSessionId: string): void
}

/** Stages hidden replacement views before the fenced durable close. */
export async function rehomeNodeBrowsers(input: NodeBrowserRehome): Promise<void> {
  input.assertCurrent()
  const descriptors = input.source.ownedTransferDescriptors()
  for (const descriptor of descriptors) {
    if (!input.sourceWorkspaceIds.has(descriptor.workspaceId)) {
      throw new Error('A native browser is outside the closing window placement')
    }
    if (input.target.ownsSession(descriptor.browserSessionId)) {
      throw new Error('The target already owns a browser being transferred')
    }
  }

  const staged: { descriptor: BrowserDescriptor; rollback: () => void }[] = []
  const rollback = (): void => {
    for (const { descriptor, rollback: resume } of staged.reverse()) {
      input.target.destroyOwnedSession(descriptor.browserSessionId)
      resume()
    }
  }
  try {
    for (const descriptor of descriptors) {
      input.assertCurrent()
      const resume = input.source.suspendOwnedSession(descriptor.browserSessionId)
      staged.push({ descriptor, rollback: resume })
      await input.target.mountTransferred(descriptor)
    }
    input.assertCurrent()
  } catch (error) {
    rollback()
    throw error
  }

  try {
    await input.commit()
  } catch (error) {
    const outcome = await input.resolveCommit().catch(() => 'unknown' as const)
    if (outcome === 'not-committed') {
      rollback()
      throw error
    }
    if (outcome === 'unknown') {
      // The close may have committed. Keep source input suspended and the hidden
      // target views alive until the service topology can be reconciled.
      throw new Error('Node window close outcome is unknown; native browser transfer is quarantined', {
        cause: error
      })
    }
  }

  for (const { descriptor } of staged) {
    input.target.activateTransferredSession(descriptor.browserSessionId)
    input.source.destroyOwnedSession(descriptor.browserSessionId)
    input.transferred(descriptor.browserSessionId)
  }
}
