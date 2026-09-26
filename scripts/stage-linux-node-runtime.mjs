import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import console from 'node:console'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'target', 'node-linux')
const requiredNodeVersion = '22.22.3'

function assertLinuxRuntime() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('The Node runtime stage currently supports Linux x64 only')
  }
  if (process.versions.node !== requiredNodeVersion) {
    throw new Error(`Node ${requiredNodeVersion} is required to stage the Linux runtime`)
  }
}

async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function keepDeploySelfContained(staging, server) {
  // pnpm's legacy deploy leaves this workspace self-link pointing back at the checkout.
  const selfLink = join(
    server,
    'node_modules',
    '.pnpm',
    'node_modules',
    '@agent-workspace',
    'server'
  )
  if (
    !(await lstat(selfLink)).isSymbolicLink() ||
    (await realpath(selfLink)) !== join(root, 'apps', 'server')
  ) {
    throw new Error('The deployed server self-link is unexpected')
  }
  await unlink(selfLink)
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        const inside = relative(staging, target)
        if (inside === '..' || inside.startsWith(`..${sep}`)) {
          throw new Error(
            `The deployed runtime links outside its stage: ${relative(staging, path)}`
          )
        }
      } else if (entry.isDirectory()) {
        await inspect(path)
      }
    }
  }
  await inspect(staging)
}

async function main() {
  assertLinuxRuntime()
  const nodeBinary = await realpath(process.execPath)
  const nodeLicense = resolve(dirname(nodeBinary), '..', 'LICENSE')
  if (!(await stat(nodeBinary)).isFile() || !(await stat(nodeLicense)).isFile()) {
    throw new Error('The Node executable and its license must come from the same distribution')
  }
  const serverBundle = join(root, 'apps', 'server', 'dist', 'bin.mjs')
  const enrollmentBundle = join(root, 'apps', 'server', 'dist', 'credential-enroll.mjs')
  const recoveryBundle = join(root, 'apps', 'server', 'dist', 'recovery-export.mjs')
  const exchangeAddon = join(root, 'apps', 'server', 'dist', 'rename-exchange.node')
  const sealAddon = join(root, 'apps', 'server', 'dist', 'seal-executable.node')
  const cliBundle = join(root, 'apps', 'cli', 'dist', 'bin.mjs')
  await Promise.all([
    access(serverBundle),
    access(enrollmentBundle),
    access(recoveryBundle),
    access(exchangeAddon),
    access(sealAddon),
    access(cliBundle)
  ])

  const existing = await lstat(output).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Existing Node runtime stage is not a directory: ${output}`)
    }
    execFileSync(
      process.execPath,
      [join(root, 'scripts/release/verify-node-preview.mjs'), output],
      {
        stdio: 'pipe'
      }
    )
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const sources = {
      nodeSha256: nodeBinary,
      serverSha256: serverBundle,
      enrollmentSha256: enrollmentBundle,
      recoverySha256: recoveryBundle,
      exchangeSha256: exchangeAddon,
      sealSha256: sealAddon,
      cliSha256: cliBundle,
      licenseSha256: nodeLicense
    }
    for (const [key, source] of Object.entries(sources)) {
      if (manifest[key] !== (await digest(source))) {
        throw new Error(`Existing Node runtime stage is stale: ${key}; remove it explicitly`)
      }
    }
    console.log(`Reusing verified ${relative(root, output)}`)
    return
  }

  const staging = join(root, 'target', `node-linux-stage-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  try {
    const server = join(staging, 'server')
    execFileSync(
      'pnpm',
      [
        '--config.strict-peer-dependencies=false',
        '--filter',
        '@agent-workspace/server',
        'deploy',
        '--prod',
        '--legacy',
        server
      ],
      { cwd: root, stdio: 'inherit' }
    )
    await keepDeploySelfContained(staging, server)
    await mkdir(join(staging, 'bin'))
    await mkdir(join(staging, 'licenses'))
    await copyFile(nodeBinary, join(staging, 'bin', 'node'), constants.COPYFILE_EXCL)
    await copyFile(nodeLicense, join(staging, 'licenses', 'Node-LICENSE'), constants.COPYFILE_EXCL)
    await copyFile(
      cliBundle,
      join(staging, 'bin', 'agent-workspace-node.mjs'),
      constants.COPYFILE_EXCL
    )

    const stagedNode = join(staging, 'bin', 'node')
    const stagedServer = join(server, 'dist', 'bin.mjs')
    const stagedEnrollment = join(server, 'dist', 'credential-enroll.mjs')
    const stagedRecovery = join(server, 'dist', 'recovery-export.mjs')
    const stagedExchange = join(server, 'dist', 'rename-exchange.node')
    const stagedSeal = join(server, 'dist', 'seal-executable.node')
    const stagedCli = join(staging, 'bin', 'agent-workspace-node.mjs')
    if ((await digest(stagedServer)) !== (await digest(serverBundle))) {
      throw new Error('The deployed server bundle differs from the built bundle')
    }
    if ((await digest(stagedEnrollment)) !== (await digest(enrollmentBundle))) {
      throw new Error('The deployed enrollment bundle differs from the built bundle')
    }
    if ((await digest(stagedRecovery)) !== (await digest(recoveryBundle))) {
      throw new Error('The deployed recovery bundle differs from the built bundle')
    }
    if ((await digest(stagedExchange)) !== (await digest(exchangeAddon))) {
      throw new Error('The deployed rename exchange addon differs from the built addon')
    }
    if ((await digest(stagedSeal)) !== (await digest(sealAddon))) {
      throw new Error('The deployed sealed executable addon differs from the built addon')
    }
    // Exercise both native addons with the actual staged executable and module tree.
    execFileSync(stagedNode, ['-e', "require('better-sqlite3'); require('node-pty')"], {
      cwd: server,
      stdio: 'pipe'
    })
    execFileSync(stagedNode, ['-e', "require('./dist/rename-exchange.node')"], {
      cwd: server,
      stdio: 'pipe'
    })
    execFileSync(stagedNode, ['-e', "require('./dist/seal-executable.node')"], {
      cwd: server,
      stdio: 'pipe'
    })
    const version = execFileSync(stagedNode, ['-p', 'process.versions.node'], {
      encoding: 'utf8'
    }).trim()
    if (version !== requiredNodeVersion)
      throw new Error('The staged Node binary changed during copy')
    execFileSync(stagedNode, [stagedCli, '--help'], { cwd: staging, stdio: 'pipe' })
    const manifest = {
      kind: 'agent-workspace-node-linux-x64',
      nodeVersion: process.versions.node,
      nodeModuleAbi: process.versions.modules,
      nodeSha256: await digest(stagedNode),
      serverSha256: await digest(stagedServer),
      enrollmentSha256: await digest(stagedEnrollment),
      recoverySha256: await digest(stagedRecovery),
      exchangeSha256: await digest(stagedExchange),
      sealSha256: await digest(stagedSeal),
      cliSha256: await digest(stagedCli),
      licenseSha256: await digest(join(staging, 'licenses', 'Node-LICENSE'))
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o644
    })
    await chmod(staging, 0o755)
    await rename(staging, output)
    console.log(`Staged ${relative(root, output)} with Node ${manifest.nodeVersion}`)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

await main()
