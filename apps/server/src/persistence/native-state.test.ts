import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ApplicationStateStore } from './application-state-store'

describe('native Node profile', () => {
  it('creates a valid durable workspace and reopens it without replacing the database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-workspace-native-test-'))
    try {
      const path = join(root, 'state.sqlite')
      const backup = join(root, 'pre-node.sqlite')
      const initial = await ApplicationStateStore.openNative(path, backup, root)
      const snapshot = initial.readSnapshot()
      expect(snapshot.workspaces).toHaveLength(1)
      expect(snapshot.selectedWorkspaceId).toBe(snapshot.workspaces[0]?.id)
      initial.close()
      const reopened = await ApplicationStateStore.openNative(path, backup, root)
      expect(reopened.readSnapshot()).toEqual(snapshot)
      reopened.close()
      expect(existsSync(backup)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
