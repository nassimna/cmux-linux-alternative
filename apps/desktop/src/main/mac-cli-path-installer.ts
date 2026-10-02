import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readlink, symlink, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const canonicalSource = '/Applications/Ternline.app/Contents/Resources/cli/ternline-cli'
const previousPkgLauncher = `#!/bin/sh
# Ternline installer command-line launcher
exec ${canonicalSource} "$@"
`
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const permissionDenied = (error: unknown): boolean =>
  ['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '')

/** Only explicit desktop actions install the global command. Shell profiles are never changed. */
export class MacCliPathInstaller {
  public readonly sourcePath: string
  public readonly destinationPath: string
  private readonly runPrivileged: (command: string) => Promise<void>

  public constructor(options: {
    sourcePath: string
    destinationPath?: string
    runPrivileged?: (command: string) => Promise<void>
  }) {
    this.sourcePath = resolve(options.sourcePath)
    this.destinationPath = resolve(options.destinationPath ?? '/usr/local/bin/ternline-cli')
    this.runPrivileged =
      options.runPrivileged ??
      (async (command) => {
        await execute('/usr/bin/osascript', [
          '-e',
          'on run argv',
          '-e',
          'do shell script (item 1 of argv) with administrator privileges',
          '-e',
          'end run',
          command
        ])
      })
  }

  public async isInstalled(): Promise<boolean> {
    const entry = await this.destinationEntry()
    if (!entry?.isSymbolicLink()) return false
    const target = resolve(dirname(this.destinationPath), await readlink(this.destinationPath))
    return target === this.sourcePath
  }

  public async install(): Promise<void> {
    await access(this.sourcePath, constants.X_OK)
    if (await this.isInstalled()) return
    await this.change('install')
    if (!(await this.isInstalled())) throw new Error('The CLI symlink could not be verified.')
  }

  public async uninstall(): Promise<void> {
    await this.change('uninstall')
    if (await this.destinationEntry()) throw new Error('The CLI command could not be removed.')
  }

  private async destinationEntry() {
    try {
      return await lstat(this.destinationPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async ensureOwnedDestination(): Promise<boolean> {
    const entry = await this.destinationEntry()
    if (!entry) return false
    if (entry.isSymbolicLink()) {
      const target = resolve(dirname(this.destinationPath), await readlink(this.destinationPath))
      if (target === this.sourcePath || target === canonicalSource) return true
    } else if (entry.isFile() && entry.size === Buffer.byteLength(previousPkgLauncher)) {
      if ((await readFile(this.destinationPath, 'utf8')) === previousPkgLauncher) return true
    }
    throw new Error(
      `An unrelated or modified command exists at ${this.destinationPath}. Move it before installing or uninstalling ternline-cli.`
    )
  }

  private async change(action: 'install' | 'uninstall'): Promise<void> {
    const exists = await this.ensureOwnedDestination()
    if (action === 'uninstall' && !exists) return
    try {
      if (action === 'install') await mkdir(dirname(this.destinationPath), { recursive: true })
      // Recheck immediately before replacing a command, including after directory creation.
      if (await this.ensureOwnedDestination()) await unlink(this.destinationPath)
      if (action === 'install') await symlink(this.sourcePath, this.destinationPath)
    } catch (error) {
      if (!permissionDenied(error)) throw error
      await this.ensureOwnedDestination()
      await this.runPrivileged(this.privilegedCommand(action))
    }
  }

  private privilegedCommand(action: 'install' | 'uninstall'): string {
    // Authorization can take time. Recheck ownership in the privileged process too.
    const destination = quote(this.destinationPath)
    const source = quote(this.sourcePath)
    const guard = `if [ -e ${destination} ] || [ -L ${destination} ]; then
if [ -L ${destination} ]; then
target=$(/usr/bin/readlink ${destination})
case "$target" in /*) ;; *) target=${quote(dirname(this.destinationPath))}/"$target" ;; esac
[ "$target" = ${source} ] || [ "$target" = ${quote(canonicalSource)} ] || exit 1
else
[ -f ${destination} ] && /usr/bin/printf '%s' ${quote(previousPkgLauncher)} | /usr/bin/cmp -s - ${destination} || exit 1
fi
/bin/rm -f ${destination}
fi`
    return action === 'install'
      ? `set -eu\n/bin/test -x ${source}\n/bin/mkdir -p ${quote(dirname(this.destinationPath))}\n${guard}\n/bin/ln -s ${source} ${destination}`
      : `set -eu\n${guard}`
  }
}
