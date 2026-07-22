/** Opens provider polling only after the current exact binding set has completed successfully. */
export class ProviderPollingGate {
  #deferrals = 0

  public bindingReady(startPolling: () => void): void {
    if (this.#deferrals === 0) startPolling()
  }

  public async bindAll(operation: () => Promise<void>, startPolling: () => void): Promise<void> {
    this.#deferrals += 1
    let succeeded = false
    try {
      await operation()
      succeeded = true
    } finally {
      this.#deferrals -= 1
      if (succeeded && this.#deferrals === 0) startPolling()
    }
  }
}
