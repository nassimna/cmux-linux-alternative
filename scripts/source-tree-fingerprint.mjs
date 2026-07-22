import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const includedRoots = ['.cargo', '.github', 'apps', 'crates', 'integrations', 'packages', 'scripts']
const includedRootFiles = [
  '.editorconfig',
  '.npmrc',
  '.prettierignore',
  'Cargo.lock',
  'Cargo.toml',
  'eslint.config.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'prettier.config.mjs',
  'rust-toolchain.toml',
  'tsconfig.base.json'
]
const ignoredDirectoryNames = new Set([
  '.git',
  'dogfood-output',
  'node_modules',
  'out',
  'playwright-report',
  'release',
  'target',
  'test-results'
])

const files = []
for (const root of includedRoots) await collect(resolve(repositoryRoot, root))
for (const file of includedRootFiles) files.push(resolve(repositoryRoot, file))
files.sort((left, right) => normalizedRelative(left).localeCompare(normalizedRelative(right)))

const manifestHash = createHash('sha256')
for (const file of files) {
  const metadata = await lstat(file)
  const contents = metadata.isSymbolicLink()
    ? Buffer.from(`symlink:${await readlink(file)}`, 'utf8')
    : await readFile(file)
  const fileHash = createHash('sha256').update(contents).digest('hex')
  manifestHash.update(`${fileHash}  ${normalizedRelative(file)}\n`, 'utf8')
}

process.stdout.write(
  `${JSON.stringify({ algorithm: 'sha256', fileCount: files.length, digest: manifestHash.digest('hex') })}\n`
)

async function collect(path) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory()) {
    files.push(path)
    return
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue
    await collect(resolve(path, entry.name))
  }
}

function normalizedRelative(path) {
  return relative(repositoryRoot, path).split(sep).join('/')
}
