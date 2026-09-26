import { createHash } from 'node:crypto'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

if (!process.argv[2]) throw new Error('packaged Node runtime path is required')
const root = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
if (manifest.kind !== 'agent-workspace-node-linux-x64' || manifest.nodeVersion !== '22.22.3') {
  throw new Error('unexpected packaged Node runtime identity')
}

const required = {
  nodeSha256: 'bin/node',
  serverSha256: 'server/dist/bin.mjs',
  enrollmentSha256: 'server/dist/credential-enroll.mjs',
  recoverySha256: 'server/dist/recovery-export.mjs',
  exchangeSha256: 'server/dist/rename-exchange.node',
  sealSha256: 'server/dist/seal-executable.node',
  cliSha256: 'bin/agent-workspace-node.mjs',
  licenseSha256: 'licenses/Node-LICENSE'
}
for (const [key, name] of Object.entries(required)) {
  const path = join(root, name)
  const inside = relative(root, await realpath(path))
  if (inside === '..' || inside.startsWith(`..${sep}`)) {
    throw new Error(`packaged Node runtime link escapes its root: ${name}`)
  }
  if (!(await lstat(path)).isFile()) throw new Error(`packaged Node runtime file missing: ${name}`)
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  if (hash !== manifest[key]) throw new Error(`packaged Node runtime hash mismatch: ${name}`)
}

const node = join(root, required.nodeSha256)
const server = join(root, 'server')
const version = execFileSync(node, ['--version'], { encoding: 'utf8' }).trim()
if (version !== 'v22.22.3') throw new Error(`unexpected packaged Node version: ${version}`)
execFileSync(node, [join(root, required.cliSha256), '--help'], { cwd: root, stdio: 'pipe' })
for (const module of ['better-sqlite3', 'node-pty', './dist/rename-exchange.node', './dist/seal-executable.node']) {
  execFileSync(node, ['-e', `require(${JSON.stringify(module)})`], { cwd: server, stdio: 'pipe' })
}
process.stdout.write('Packaged Node executable, server, CLI, and native addons verified\n')
