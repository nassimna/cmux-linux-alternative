import { describe, expect, it, vi } from 'vitest'

import { publicActionCommandId, publicActionCommands } from './public-actions'

const definition = (actionId: string, category = 'custom') => ({
  actionId,
  actionVersion: 1,
  localizedTitleKey: `actions.${actionId.replaceAll('.', '_')}`,
  category,
  owner: 'service' as const,
  parameterSchemaVersion: 1,
  resultSchemaVersion: 1,
  authorizationClass: 'owner' as const,
  interactionClass: 'headless' as const,
  limits: { maxParameterBytes: 1024, maxResultBytes: 1024, timeoutMs: 30_000 }
})

describe('public action command adapters', () => {
  it('gives every versioned definition a collision-free synthetic command ID', () => {
    expect(publicActionCommandId(definition('workspace.close'))).toBe(
      'public-action:workspace.close@1'
    )
  })

  it('makes parameterless project actions runnable and keeps typed actions discoverable', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const commands = publicActionCommands(
      [definition('project.example.build'), definition('workspace.close', 'workspace')],
      invoke
    )

    expect(commands[0]).toMatchObject({
      callableFromPalette: true,
      command: { title: 'Project Example Build', category: 'workspace' }
    })
    await commands[0]?.command.handler({ invoke: vi.fn() })
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'project.example.build' })
    )
    expect(commands[1]?.command.isAvailable?.({ invoke: vi.fn() })).toEqual({
      available: false,
      reason: 'Use the action’s typed UI or CLI entry point.'
    })
  })

  it('uses trusted dynamic titles and canonical project shortcuts', () => {
    const [entry] = publicActionCommands(
      [
        {
          ...definition('project.example.build'),
          displayTitle: 'Build verified project',
          defaultShortcut: 'Primary+Shift+B'
        }
      ],
      vi.fn()
    )

    expect(entry?.command).toMatchObject({
      title: 'Build verified project',
      defaultShortcut: { modifiers: ['Primary', 'Shift'], key: 'B' }
    })
  })
})
