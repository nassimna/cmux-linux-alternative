import { dirname, join } from 'node:path'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { readArtifact } from './live-settings-preflight'
import { stageLiveSettings } from './live-settings-stage'

/** Preserve the existing desktop configuration on the first native Node open. */
export async function stageNativeProfileSettings(
  databasePath: string,
  state: ApplicationStateStore
): Promise<void> {
  const stateDirectory = dirname(databasePath)
  const legacyPath = join(dirname(stateDirectory), 'configuration', 'desktop.json')
  const nodePath = join(stateDirectory, 'config.json')
  const legacy = await readArtifact(legacyPath, 'desktop.json')
  if (legacy.report.status === 'absent') return
  const node = await readArtifact(nodePath, 'config.json')
  if (node.report.status === 'present') return
  const snapshot = state.readSnapshot()
  await stageLiveSettings(
    legacyPath,
    nodePath,
    {
      notificationSettings: snapshot.notificationSettings,
      shortcutOverrides: snapshot.shortcutOverrides
    },
    state.liveOwnerEvidence(databasePath)
  )
}
