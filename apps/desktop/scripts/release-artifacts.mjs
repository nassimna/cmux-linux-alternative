import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ARTIFACT_BASENAME = 'agent-workspace'
const MANIFEST_NAME = 'SHA256SUMS'
const REQUIRED_EXTENSIONS = ['AppImage', 'deb', 'rpm']
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

export async function createReleaseManifest({ releaseDirectory, version }) {
  const directory = await validatedReleaseDirectory(releaseDirectory)
  const artifacts = await requiredArtifacts(directory, version)
  const lines = []
  for (const artifact of artifacts) {
    lines.push(`${await hashRegularFile(join(directory, artifact))}  ${artifact}`)
  }
  const content = `${lines.join('\n')}\n`
  const destination = join(directory, MANIFEST_NAME)
  const temporary = join(directory, `.${MANIFEST_NAME}.${process.pid}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, destination)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
  return { artifacts, manifest: destination }
}

export async function verifyReleaseManifest({ releaseDirectory, version }) {
  const directory = await validatedReleaseDirectory(releaseDirectory)
  const artifacts = await requiredArtifacts(directory, version)
  const manifestPath = join(directory, MANIFEST_NAME)
  const manifest = await readRegularFile(manifestPath)
  const expectedNames = new Set(artifacts)
  const foundNames = new Set()
  const lines = manifest.toString('utf8').split('\n')
  if (lines.at(-1) !== '') throw new Error(`${MANIFEST_NAME} must end with a newline`)
  lines.pop()
  if (lines.length !== artifacts.length) {
    throw new Error(`${MANIFEST_NAME} must contain exactly ${artifacts.length} entries`)
  }
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/u.exec(line)
    if (!match) throw new Error(`Invalid ${MANIFEST_NAME} entry`)
    const [, expectedHash, name] = match
    if (!expectedNames.has(name) || foundNames.has(name) || basename(name) !== name) {
      throw new Error(`Unexpected or duplicate artifact in ${MANIFEST_NAME}: ${name}`)
    }
    const actualHash = await hashRegularFile(join(directory, name))
    if (actualHash !== expectedHash) throw new Error(`Checksum mismatch for ${name}`)
    foundNames.add(name)
  }
  if (foundNames.size !== expectedNames.size) throw new Error(`${MANIFEST_NAME} is incomplete`)
  return { artifacts, manifest: manifestPath }
}

async function validatedReleaseDirectory(releaseDirectory) {
  const requested = resolve(releaseDirectory)
  const info = await lstat(requested)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Release directory must be a real directory: ${requested}`)
  }
  // Parent directories may be workspace or mounted-volume symlinks. Resolving them once while
  // rejecting a symlink at the caller-controlled final component gives every later operation one
  // stable directory without making legitimate checked-out workspaces unusable.
  return realpath(requested)
}

async function requiredArtifacts(directory, version) {
  if (!SAFE_VERSION.test(version)) throw new Error(`Invalid release version: ${version}`)
  const required = REQUIRED_EXTENSIONS.map(
    (extension) => `${ARTIFACT_BASENAME}-${version}-x86_64.${extension}`
  )
  const entries = await readdir(directory, { withFileTypes: true })
  const releaseArtifacts = entries
    .filter((entry) =>
      REQUIRED_EXTENSIONS.some((extension) => entry.name.endsWith(`.${extension}`))
    )
    .map((entry) => entry.name)
    .sort()
  const expected = [...required].sort()
  if (JSON.stringify(releaseArtifacts) !== JSON.stringify(expected)) {
    throw new Error(
      `Release directory must contain exactly ${expected.join(', ')}; found ${releaseArtifacts.join(', ') || 'none'}`
    )
  }
  for (const name of required) {
    const entry = entries.find((candidate) => candidate.name === name)
    if (!entry?.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Release artifact must be a regular file: ${name}`)
    }
  }
  return required
}

async function hashRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink < 1n)
      throw new Error(`Artifact must be a regular file: ${path}`)
    const hash = createHash('sha256')
    const stream = createReadStream(path, { autoClose: false, fd: handle.fd, start: 0 })
    for await (const chunk of stream) hash.update(chunk)
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error(`Artifact changed while hashing: ${path}`)
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 16 * 1024) throw new Error(`Invalid manifest file: ${path}`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function run() {
  const [command, ...arguments_] = process.argv.slice(2)
  const options = parseArguments(arguments_)
  if (command === 'create') {
    await createReleaseManifest(options)
  } else if (command === 'verify') {
    await verifyReleaseManifest(options)
  } else {
    throw new Error(
      'Usage: release-artifacts.mjs <create|verify> --release-dir <path> --version <x.y.z>'
    )
  }
}

function parseArguments(arguments_) {
  const values = new Map()
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index]
    const value = arguments_[index + 1]
    if (
      !key?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--') ||
      values.has(key)
    ) {
      throw new Error('Invalid release artifact arguments')
    }
    values.set(key, value)
  }
  if (values.size !== 2 || !values.has('--release-dir') || !values.has('--version')) {
    throw new Error('Both --release-dir and --version are required')
  }
  return { releaseDirectory: values.get('--release-dir'), version: values.get('--version') }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
