/** The caller owns every service, binding, and database operation in this contract. */
export interface LiveNodeHandoffOptions<TNode> {
  /** Establish a mutation fence and prove cutover prerequisites before sealing Rust.
   * Release the fence before rejecting, so a rejected attempt leaves Rust usable.
   */
  qualify: () => Promise<void>
  /** Call ServiceSupervisor.stopForHandoff(), never its ordinary stop(). */
  stopRustForHandoff: () => Promise<void>
  /** Start a Node owner against the qualified state and return its exact handle. */
  startNode: () => Promise<TNode>
  /** Publish Node bindings and release the fence only after the Node owner is ready. */
  activateNode: (node: TNode) => Promise<void>
  /** Disable mutations and bindings while ownership is uncertain. */
  failClosed: () => Promise<void>
  /**
   * Recovery must prove the old Rust owner has stopped, stop any partially started Node
   * owner, reconcile state, and create and bind a NEW Rust supervisor. The sealed
   * supervisor cannot restart.
   * Return rust-restored only after the replacement is verified usable and bindings
   * are safely reopened. If any proof is
   * unavailable, leave the application fail-closed and return manual-required.
   */
  recover: (context: LiveNodeHandoffFailure<TNode>) => Promise<'rust-restored' | 'manual-required'>
}

export type LiveNodeHandoffFailure<TNode> = {
  phase: 'rust-stop' | 'node-start' | 'node-activate'
  cause: unknown
  node?: TNode
}

export type LiveNodeHandoffResult<TNode> =
  | { status: 'node-active'; phase: 'node-activate'; node: TNode }
  | { status: 'not-started'; phase: 'qualification'; cause: unknown }
  | {
      status: 'rust-restored' | 'recovery-required'
      phase: LiveNodeHandoffFailure<TNode>['phase']
      cause: unknown
      failClosedError?: unknown
      recoveryError?: unknown
    }

/** A single-use handoff; concurrent and later callers observe the same outcome. */
export function createLiveNodeHandoff<TNode>(
  options: LiveNodeHandoffOptions<TNode>
): () => Promise<LiveNodeHandoffResult<TNode>> {
  let operation: Promise<LiveNodeHandoffResult<TNode>> | undefined
  return () => (operation ??= runHandoff(options))
}

async function runHandoff<TNode>(
  options: LiveNodeHandoffOptions<TNode>
): Promise<LiveNodeHandoffResult<TNode>> {
  try {
    await options.qualify()
  } catch (cause) {
    return { status: 'not-started', phase: 'qualification', cause }
  }

  let phase: LiveNodeHandoffFailure<TNode>['phase'] = 'rust-stop'
  let node: TNode | undefined
  try {
    await options.stopRustForHandoff()
    phase = 'node-start'
    node = await options.startNode()
    phase = 'node-activate'
    await options.activateNode(node)
    return { status: 'node-active', phase, node }
  } catch (cause) {
    const failure: LiveNodeHandoffFailure<TNode> = {
      phase,
      cause,
      ...(node === undefined ? {} : { node })
    }
    try {
      await options.failClosed()
    } catch (failClosedError) {
      return { status: 'recovery-required', phase, cause, failClosedError }
    }
    try {
      const recovery = await options.recover(failure)
      return {
        status: recovery === 'rust-restored' ? 'rust-restored' : 'recovery-required',
        phase,
        cause
      }
    } catch (recoveryError) {
      return { status: 'recovery-required', phase, cause, recoveryError }
    }
  }
}
