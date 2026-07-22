import { describe, expect, it } from 'vitest'

import { createWindowOptions } from './window-options'

describe('desktop window security', () => {
  it('keeps the renderer isolated and sandboxed', () => {
    const options = createWindowOptions('/application/preload.js')

    expect(options.webPreferences).toMatchObject({
      preload: '/application/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    })
  })

  it('applies validated saved bounds without weakening security and otherwise centers defaults', () => {
    const saved = createWindowOptions('/application/preload.js', {
      revision: 3,
      x: 44,
      y: 55,
      width: 1440,
      height: 900,
      maximized: true,
      fullscreen: false,
      displayId: '1'
    })

    expect(saved).toMatchObject({ x: 44, y: 55, width: 1440, height: 900 })
    expect(saved).not.toHaveProperty('center')
    expect(createWindowOptions('/application/preload.js')).toMatchObject({
      center: true,
      width: 1280,
      height: 800
    })
    expect(saved.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true })
  })

  it('auto-hides the in-window menu bar without changing the macOS global menu', () => {
    expect(createWindowOptions('/application/preload.js', undefined, 'linux')).toMatchObject({
      autoHideMenuBar: true,
      titleBarStyle: 'default'
    })
    expect(createWindowOptions('/application/preload.js', undefined, 'win32')).toMatchObject({
      autoHideMenuBar: true,
      titleBarStyle: 'default'
    })
    const macos = createWindowOptions('/application/preload.js', undefined, 'darwin')
    expect(macos).toMatchObject({ titleBarStyle: 'hiddenInset' })
    expect(macos).not.toHaveProperty('autoHideMenuBar')
  })
})
