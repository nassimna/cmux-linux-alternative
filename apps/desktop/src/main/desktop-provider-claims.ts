export interface DesktopProviderWindowClaim {
  readonly windowId: string
  readonly generation: number
}

/** Keeps persisted placements claimed while their native windows restore sequentially. */
export class DesktopProviderClaims {
  readonly #staged = new Map<string, number>()
  #stageToken: object | undefined

  public stage(claims: readonly DesktopProviderWindowClaim[]): () => void {
    if (this.#stageToken) throw new Error('Desktop-provider claims are already staged')
    const token = {}
    for (const claim of claims) {
      if (this.#staged.has(claim.windowId)) {
        this.#staged.clear()
        throw new Error('Desktop-provider staged claims contain duplicate windows')
      }
      this.#staged.set(claim.windowId, claim.generation)
    }
    this.#stageToken = token
    return () => {
      if (this.#stageToken !== token) return
      this.#stageToken = undefined
      this.#staged.clear()
    }
  }

  public snapshot(
    live: readonly DesktopProviderWindowClaim[]
  ): readonly DesktopProviderWindowClaim[] {
    const claims = new Map(this.#staged)
    for (const claim of live) claims.set(claim.windowId, claim.generation)
    return [...claims].map(([windowId, generation]) => ({ windowId, generation }))
  }
}
