export interface DesktopProviderWindowClaim {
  readonly windowId: string
  readonly generation: number
}

/** Retries registration until the server received the exact live generation snapshot. */
export async function registerWithStableWindowClaims<TRegistration>(options: {
  claims(): readonly DesktopProviderWindowClaim[]
  register(claims: readonly DesktopProviderWindowClaim[]): Promise<TRegistration>
  unregister(registration: TRegistration): Promise<void>
  maximumAttempts?: number
}): Promise<TRegistration> {
  const maximumAttempts = options.maximumAttempts ?? 4
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const registeredClaims = options.claims()
    const registration = await options.register(registeredClaims)
    if (sameWindowClaims(registeredClaims, options.claims())) return registration
    await options.unregister(registration).catch(() => undefined)
  }
  throw new Error('Desktop-provider window generations changed during registration')
}

function sameWindowClaims(
  left: readonly DesktopProviderWindowClaim[],
  right: readonly DesktopProviderWindowClaim[]
): boolean {
  if (left.length !== right.length) return false
  const byWindow = new Map(left.map((claim) => [claim.windowId, claim.generation]))
  return right.every((claim) => byWindow.get(claim.windowId) === claim.generation)
}
