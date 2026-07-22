export interface RendererLoadLifecycle<Client> {
  getReadyClient(): Client | undefined
  bind(client: Client): void | Promise<void>
  unbind(): void | Promise<void>
  load(): void | Promise<void>
}

export interface RendererLoadOptions {
  unbindFirst?: boolean
}

export async function loadRendererForCurrentLifecycle<Client>(
  lifecycle: RendererLoadLifecycle<Client>,
  options: RendererLoadOptions = {}
): Promise<void> {
  try {
    if (options.unbindFirst) await lifecycle.unbind()

    while (true) {
      const client = lifecycle.getReadyClient()
      if (!client) break

      await lifecycle.bind(client)
      if (lifecycle.getReadyClient() === client) break

      await lifecycle.unbind()
    }

    await lifecycle.load()
  } catch (error) {
    await Promise.resolve()
      .then(() => lifecycle.unbind())
      .catch(() => undefined)
    throw error
  }
}
