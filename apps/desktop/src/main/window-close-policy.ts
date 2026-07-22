/** Service-driven rehome must never intercept application shutdown. */
export function shouldRequestServiceWindowClose(
  windowCount: number,
  providerActive: boolean,
  quitStarted: boolean
): boolean {
  return windowCount > 1 && providerActive && !quitStarted
}
