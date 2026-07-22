import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { reloadRendererAfterCrash } from './renderer-crash-reloader'

describe('reloadRendererAfterCrash', () => {
  it('reloads the existing trusted document once when its bridge is restored', async () => {
    const fixture = windowFixture()
    finishEveryReload(fixture)

    await reloadRendererAfterCrash(fixture.window)

    expect(fixture.reload).toHaveBeenCalledOnce()
    expect(fixture.executeJavaScript).toHaveBeenCalledOnce()
  })

  it('retries one sandbox preload startup failure and waits for the rebound renderer', async () => {
    const fixture = windowFixture()
    fixture.reload
      .mockImplementationOnce(() => {
        queueMicrotask(() =>
          fixture.contents.emit('preload-error', {}, '/preload.cjs', new Error('startupData null'))
        )
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => fixture.contents.emit('did-finish-load'))
      })

    await reloadRendererAfterCrash(fixture.window)

    expect(fixture.reload).toHaveBeenCalledTimes(2)
  })

  it('retries when Electron silently loads without the isolated main-world bridge', async () => {
    const fixture = windowFixture()
    fixture.executeJavaScript.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    finishEveryReload(fixture)

    await reloadRendererAfterCrash(fixture.window)

    expect(fixture.reload).toHaveBeenCalledTimes(2)
    expect(fixture.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the isolated main-world bridge is still absent after retry', async () => {
    const fixture = windowFixture()
    fixture.executeJavaScript.mockResolvedValue(false)
    finishEveryReload(fixture)

    await expect(reloadRendererAfterCrash(fixture.window)).rejects.toThrow(
      'Renderer preload bridge is unavailable after retry'
    )
    expect(fixture.reload).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the preload retry also fails', async () => {
    const fixture = windowFixture()
    fixture.reload.mockImplementation(() => {
      const attempt = fixture.reload.mock.calls.length
      queueMicrotask(() =>
        fixture.contents.emit(
          'preload-error',
          {},
          '/preload.cjs',
          new Error(attempt === 1 ? 'first failure' : 'second failure')
        )
      )
    })

    await expect(reloadRendererAfterCrash(fixture.window)).rejects.toThrow('second failure')
    expect(fixture.reload).toHaveBeenCalledTimes(2)
  })
})

function finishEveryReload(fixture: ReturnType<typeof windowFixture>): void {
  fixture.reload.mockImplementation(() => {
    queueMicrotask(() => fixture.contents.emit('did-finish-load'))
  })
}

function windowFixture(): {
  contents: EventEmitter
  executeJavaScript: ReturnType<typeof vi.fn<() => Promise<boolean>>>
  reload: ReturnType<typeof vi.fn<() => void>>
  window: Electron.BrowserWindow
} {
  const contents = new EventEmitter()
  const reload = vi.fn<() => void>()
  const executeJavaScript = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
  return {
    contents,
    executeJavaScript,
    reload,
    window: {
      webContents: Object.assign(contents, { executeJavaScript, reload })
    } as unknown as Electron.BrowserWindow
  }
}
