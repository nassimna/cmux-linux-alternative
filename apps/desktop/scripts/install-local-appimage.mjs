import { randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const APPLICATION_ID = 'agent-workspace'

export function resolveDataHome({ environment = process.env, homeDirectory = homedir() } = {}) {
  const configured = environment.XDG_DATA_HOME
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`XDG_DATA_HOME must be an absolute path: ${configured}`)
    }
    return resolve(configured)
  }
  if (!isAbsolute(homeDirectory)) {
    throw new Error(`Home directory must be an absolute path: ${homeDirectory}`)
  }
  return join(resolve(homeDirectory), '.local', 'share')
}

export function escapeDesktopExecArgument(argument) {
  if (argument.includes('\0') || argument.includes('\n') || argument.includes('\r')) {
    throw new Error('Desktop Entry Exec arguments cannot contain control characters')
  }
  if (argument.includes('%')) {
    throw new Error('Desktop Entry Exec paths cannot contain % field-code markers')
  }
  const escapedExecArgument = argument.replaceAll(/(["`$\\])/gu, '\\$1')
  // Desktop Entry string-value escaping runs before Exec token parsing. Preserve every
  // backslash required by the Exec grammar through that first parsing layer.
  return `"${escapedExecArgument.replaceAll('\\', '\\\\')}"`
}

export async function installLocalAppImage({
  appImagePath,
  iconPath,
  dataHome = resolveDataHome()
}) {
  if (!isAbsolute(dataHome)) throw new Error(`Data home must be an absolute path: ${dataHome}`)

  const sourceAppImage = resolveRequiredPath(appImagePath, 'AppImage')
  const sourceIcon = resolveRequiredPath(iconPath, 'icon')
  if (!sourceAppImage.endsWith('.AppImage')) {
    throw new Error(`AppImage source must end in .AppImage: ${sourceAppImage}`)
  }

  const applicationDirectory = join(dataHome, APPLICATION_ID)
  const installedAppImage = join(applicationDirectory, `${APPLICATION_ID}.AppImage`)
  const installedIcon = join(
    dataHome,
    'icons',
    'hicolor',
    '512x512',
    'apps',
    `${APPLICATION_ID}.png`
  )
  const desktopEntry = join(dataHome, 'applications', `${APPLICATION_ID}.desktop`)
  const desktopEntryContent = createDesktopEntry(installedAppImage)

  await Promise.all([
    mkdir(applicationDirectory, { recursive: true }),
    mkdir(dirname(installedIcon), { recursive: true }),
    mkdir(dirname(desktopEntry), { recursive: true })
  ])

  await atomicCopyRegularFile(sourceAppImage, installedAppImage, 0o755)
  await atomicCopyRegularFile(sourceIcon, installedIcon, 0o644)
  await atomicWriteFile(desktopEntry, desktopEntryContent, 0o644)

  return { appImage: installedAppImage, desktopEntry, icon: installedIcon }
}

function createDesktopEntry(appImagePath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Workspace',
    'Comment=Cross-platform workspace for agent-driven development',
    `Exec=${escapeDesktopExecArgument(appImagePath)}`,
    'Icon=agent-workspace',
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=agent-workspace',
    ''
  ].join('\n')
}

function resolveRequiredPath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} path is required`)
  }
  return resolve(value)
}

async function atomicCopyRegularFile(source, destination, mode) {
  const sourceInfo = await lstat(source)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Source must be a regular file: ${source}`)
  }

  const temporary = temporaryPath(destination)
  let sourceHandle
  let destinationHandle
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await sourceHandle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`Source must be a regular file: ${source}`)

    destinationHandle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode
    )
    await pipeline(
      createReadStream(source, { autoClose: false, fd: sourceHandle.fd }),
      createWriteStream(temporary, { autoClose: false, fd: destinationHandle.fd })
    )
    await destinationHandle.sync()

    const after = await sourceHandle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error(`Source changed while installing: ${source}`)
    }

    await destinationHandle.close()
    destinationHandle = undefined
    await chmod(temporary, mode)
    await rename(temporary, destination)
  } finally {
    await destinationHandle?.close().catch(() => undefined)
    await sourceHandle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function atomicWriteFile(destination, content, mode) {
  const temporary = temporaryPath(destination)
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode
    )
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await chmod(temporary, mode)
    await rename(temporary, destination)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function temporaryPath(destination) {
  return join(dirname(destination), `.${APPLICATION_ID}.${process.pid}.${randomUUID()}.tmp`)
}

function parseArguments(arguments_) {
  const options = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (
      !['--appimage', '--icon'].includes(key) ||
      value === undefined ||
      value.startsWith('--') ||
      options.has(key)
    ) {
      throw new Error('Usage: install-local-appimage.mjs --appimage <path> --icon <512x512.png>')
    }
    options.set(key, value)
  }
  if (options.size !== 2 || !options.has('--appimage') || !options.has('--icon')) {
    throw new Error('Usage: install-local-appimage.mjs --appimage <path> --icon <512x512.png>')
  }
  return { appImagePath: options.get('--appimage'), iconPath: options.get('--icon') }
}

async function run() {
  const installed = await installLocalAppImage(parseArguments(process.argv.slice(2)))
  process.stdout.write(`Installed local AppImage: ${installed.appImage}\n`)
  process.stdout.write(`Installed desktop entry: ${installed.desktopEntry}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
