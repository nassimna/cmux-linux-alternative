import { describe, expect, it } from 'vitest'
import type { ApplicationSnapshot } from '@agent-workspace/protocol-client'

import { runtimeResourceIds } from './renderer-ownership-reconciliation'

describe('runtimeResourceIds', () => {
  it('retains live terminal and browser resources while omitting unstarted terminals', () => {
    const snapshot = {
      workspaces: [
        {
          tabs: [
            { content: { kind: 'terminal', runtimeSessionId: 'terminal-live' } },
            { content: { kind: 'terminal' } },
            { content: { kind: 'browser', state: { browserSessionId: 'browser-live' } } }
          ]
        }
      ]
    } as unknown as ApplicationSnapshot

    expect(runtimeResourceIds(snapshot)).toEqual(new Set(['terminal-live', 'browser-live']))
  })
})
