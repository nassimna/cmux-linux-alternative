import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import type {
  DesktopWorkspacePathOpener,
  DesktopWorkspacePathOpenerId
} from '@agent-workspace/contracts/desktop/desktop-bridge'

interface IdeDefinition {
  readonly id: Exclude<DesktopWorkspacePathOpenerId, 'fileManager'>
  readonly label: string
  readonly commands: readonly string[]
}

const IDE_DEFINITIONS: readonly IdeDefinition[] = [
  { id: 'vscode', label: 'Visual Studio Code', commands: ['code'] },
  { id: 'vscodeInsiders', label: 'Visual Studio Code - Insiders', commands: ['code-insiders'] },
  { id: 'vscodium', label: 'VSCodium', commands: ['codium'] },
  { id: 'cursor', label: 'Cursor', commands: ['cursor'] },
  { id: 'windsurf', label: 'Windsurf', commands: ['windsurf'] },
  { id: 'zed', label: 'Zed', commands: ['zed'] },
  { id: 'sublimeText', label: 'Sublime Text', commands: ['subl'] },
  { id: 'kate', label: 'Kate', commands: ['kate'] },
  { id: 't3Code', label: 'T3 Code', commands: ['t3code', 't3code-nightly'] },
  { id: 'intellijIdea', label: 'IntelliJ IDEA', commands: ['idea', 'intellij-idea-ultimate'] },
  { id: 'webstorm', label: 'WebStorm', commands: ['webstorm'] },
  { id: 'pycharm', label: 'PyCharm', commands: ['pycharm', 'pycharm-professional'] },
  { id: 'goland', label: 'GoLand', commands: ['goland'] },
  { id: 'clion', label: 'CLion', commands: ['clion'] },
  { id: 'rider', label: 'Rider', commands: ['rider'] },
  { id: 'fleet', label: 'Fleet', commands: ['fleet'] },
  { id: 'androidStudio', label: 'Android Studio', commands: ['studio', 'android-studio'] }
]

async function executablePath(
  commands: readonly string[],
  searchPath = process.env.PATH ?? ''
): Promise<string | null> {
  for (const command of commands) {
    for (const directory of searchPath.split(delimiter).filter(Boolean)) {
      const candidate = join(directory, command)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Continue through the bounded, whitelisted candidates.
      }
    }
  }
  return null
}

export async function detectWorkspacePathOpeners(
  searchPath = process.env.PATH ?? ''
): Promise<readonly DesktopWorkspacePathOpener[]> {
  const detected = await Promise.all(
    IDE_DEFINITIONS.map(async (definition) =>
      (await executablePath(definition.commands, searchPath))
        ? ({ id: definition.id, label: definition.label, kind: 'ide' } as const)
        : null
    )
  )
  return [
    { id: 'fileManager', label: 'File Explorer', kind: 'fileManager' },
    ...detected.filter((opener): opener is NonNullable<typeof opener> => opener !== null)
  ]
}

export async function launchWorkspacePathInIde(
  openerId: Exclude<DesktopWorkspacePathOpenerId, 'fileManager'>,
  workspacePath: string,
  searchPath = process.env.PATH ?? ''
): Promise<void> {
  const definition = IDE_DEFINITIONS.find(({ id }) => id === openerId)
  if (!definition) throw new Error('Unknown workspace IDE')
  const command = await executablePath(definition.commands, searchPath)
  if (!command) throw new Error(`${definition.label} is no longer available`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [workspacePath], {
      detached: true,
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
