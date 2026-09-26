import { describe, expect, it, vi } from 'vitest'

import type { DesktopBridge } from '@agent-workspace/contracts/desktop/desktop-bridge'
import { bindApplicationMenuCommands, buildApplicationMenuState } from './application-menu'
import { defaultCommandRegistry } from './registry'
import { parseShortcut } from './shortcuts'

describe('renderer application menu projection', () => {
  it('projects availability, overrides, and conflict-safe accelerators', () => {
    const conflict = parseShortcut('Primary+O')
    if (!conflict.valid) throw new Error(conflict.reason)
    const state = buildApplicationMenuState(
      defaultCommandRegistry,
      {
        invoke: vi.fn(),
        capabilities: [],
        selection: { workspace: false, pane: false, tab: false, terminal: false },
        browser: null
      },
      {
        'terminal.new': conflict.shortcut,
        'sidebar.toggle': null
      },
      'other'
    )
    const byId = new Map(state.commands.map((command) => [command.commandId, command]))

    expect(byId.get('workspace.new')).toMatchObject({ enabled: true, shortcut: null })
    expect(byId.get('terminal.new')).toMatchObject({ enabled: false, shortcut: null })
    expect(byId.get('sidebar.toggle')).toMatchObject({ enabled: true, shortcut: null })
    expect(byId.get('browser.openSplit')).toMatchObject({ enabled: false })
    expect(state.commands.some(({ commandId }) => commandId === ('tab.close' as never))).toBe(false)
  })

  it('dispatches validated native events through the shared registry and cleans up', async () => {
    let listener: ((commandId: 'workspace.new') => void) | undefined
    const remove = vi.fn()
    const bridge = {
      onApplicationMenuCommand: vi.fn((next) => {
        listener = next as (commandId: 'workspace.new') => void
        return remove
      })
    } as unknown as DesktopBridge
    const invoke = vi.fn()
    const executed = vi.fn()
    const dispose = bindApplicationMenuCommands(bridge, () => ({ invoke }), executed)

    listener?.('workspace.new')
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('workspace.new')
      expect(executed).toHaveBeenCalledWith('workspace.new')
    })

    dispose()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('does not install accelerators that collide with platform Edit roles', () => {
    const copy = parseShortcut('Primary+C')
    const redo = parseShortcut('Primary+Y')
    if (!copy.valid || !redo.valid) throw new Error('Invalid test shortcut')

    const other = buildApplicationMenuState(
      defaultCommandRegistry,
      { invoke: vi.fn() },
      { 'workspace.new': copy.shortcut, 'terminal.new': redo.shortcut },
      'other'
    )
    const macos = buildApplicationMenuState(
      defaultCommandRegistry,
      { invoke: vi.fn() },
      { 'workspace.new': copy.shortcut, 'terminal.new': redo.shortcut },
      'macos'
    )

    expect(
      other.commands.find(({ commandId }) => commandId === 'workspace.new')?.shortcut
    ).toBeNull()
    expect(
      other.commands.find(({ commandId }) => commandId === 'terminal.new')?.shortcut
    ).toBeNull()
    expect(
      macos.commands.find(({ commandId }) => commandId === 'workspace.new')?.shortcut
    ).toBeNull()
    expect(macos.commands.find(({ commandId }) => commandId === 'terminal.new')?.shortcut).toEqual(
      redo.shortcut
    )
  })

  it('does not install accelerators owned by application and Window roles', () => {
    const cases = [
      { platform: 'other' as const, shortcut: 'Primary+Q', reserved: true },
      { platform: 'other' as const, shortcut: 'Primary+M', reserved: true },
      { platform: 'other' as const, shortcut: 'Primary+H', reserved: false },
      { platform: 'other' as const, shortcut: 'Primary+Secondary+H', reserved: false },
      { platform: 'macos' as const, shortcut: 'Primary+Q', reserved: true },
      { platform: 'macos' as const, shortcut: 'Primary+M', reserved: true },
      { platform: 'macos' as const, shortcut: 'Primary+H', reserved: true },
      { platform: 'macos' as const, shortcut: 'Primary+Secondary+H', reserved: true },
      { platform: 'macos' as const, shortcut: 'Primary+Shift+Q', reserved: false }
    ]

    for (const { platform, reserved, shortcut } of cases) {
      const parsed = parseShortcut(shortcut)
      if (!parsed.valid) throw new Error(parsed.reason)
      const state = buildApplicationMenuState(
        defaultCommandRegistry,
        { invoke: vi.fn() },
        { 'workspace.new': parsed.shortcut },
        platform
      )
      const projected = state.commands.find(({ commandId }) => commandId === 'workspace.new')

      expect(projected, `${platform} ${shortcut}`).toMatchObject({ enabled: true })
      expect(projected?.shortcut, `${platform} ${shortcut}`).toEqual(
        reserved ? null : parsed.shortcut
      )
    }
  })
})
