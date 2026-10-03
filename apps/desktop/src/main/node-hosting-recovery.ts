/** The existing heartbeat interval retries this after a temporary hosting failure. */
export async function recoverNodeWindowHosting(options: {
  isCurrent(): boolean
  stopAutomation(): void
  nextGeneration(): number
  registerHosting(generation: number): Promise<void>
  startAutomation(): Promise<void>
  logError(error: unknown): void
}): Promise<boolean> {
  if (!options.isCurrent()) return false
  options.stopAutomation()
  try {
    await options.registerHosting(options.nextGeneration())
    if (!options.isCurrent()) return false
    await options.startAutomation()
    return options.isCurrent()
  } catch (error) {
    if (options.isCurrent()) options.logError(error)
    return false
  }
}
