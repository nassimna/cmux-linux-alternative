import { describe, expect, it } from 'vitest'

import { keyboardDropToMutation, pointerDropToMutation, pointerToDropAction } from './intents'

describe('pointer and keyboard mutation parity', () => {
  const source = { tabId: 'tab-1', sourcePaneId: 'pane-1' }
  const targetRect = { x: 0, y: 0, width: 200, height: 120 }

  it('produces the same serializable split intent', () => {
    const pointer = pointerDropToMutation({
      ...source,
      targetPaneId: 'pane-2',
      targetIndex: 0,
      targetRect,
      point: { x: 10, y: 60 }
    })
    const keyboard = keyboardDropToMutation(source, {
      kind: 'split',
      targetPaneId: 'pane-2',
      direction: 'left'
    })
    expect(pointer).toEqual(keyboard)
    expect(JSON.parse(JSON.stringify(pointer))).toEqual(keyboard)
  })

  it('produces the same serializable move intent', () => {
    const pointer = pointerDropToMutation({
      ...source,
      targetPaneId: 'pane-2',
      targetIndex: 3,
      targetRect,
      point: { x: 100, y: 60 }
    })
    const keyboard = keyboardDropToMutation(source, {
      kind: 'move',
      targetPaneId: 'pane-2',
      targetIndex: 3
    })
    expect(pointer).toEqual(keyboard)
  })

  it('maps pointer position to a reusable drop action before mutation', () => {
    expect(
      pointerToDropAction({
        targetPaneId: 'pane-2',
        targetIndex: 3,
        targetRect,
        point: { x: 100, y: 10 }
      })
    ).toEqual({ kind: 'split', targetPaneId: 'pane-2', direction: 'top' })
  })

  it('rejects invalid identities, indices, and pointer geometry', () => {
    expect(
      keyboardDropToMutation(source, { kind: 'move', targetPaneId: 'pane-2', targetIndex: -1 })
    ).toBeNull()
    expect(
      pointerDropToMutation({
        ...source,
        targetPaneId: 'pane-2',
        targetIndex: 0,
        targetRect,
        point: { x: Number.NaN, y: 0 }
      })
    ).toBeNull()
  })
})
