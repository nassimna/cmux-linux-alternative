import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

function executablePath(context) {
  const productFilename = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
  }
  if (context.electronPlatformName === 'win32') {
    return join(context.appOutDir, `${productFilename}.exe`)
  }
  return join(context.appOutDir, context.packager.executableName)
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function includeOptionalLinuxNodeRuntime(context) {
  if (process.env.AGENT_WORKSPACE_PACKAGE_NODE_RUNTIME !== '1') return
  if (context.electronPlatformName !== 'linux' || process.arch !== 'x64') {
    throw new Error('The optional Node runtime package supports Linux x64 only')
  }

  const source = resolve(context.packager.projectDir, '../../target/node-linux')
  if (!(await lstat(source)).isDirectory() || (await realpath(source)) !== source) {
    throw new Error('The staged Node runtime must be a real directory')
  }
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  if (manifest.kind !== 'agent-workspace-node-linux-x64') {
    throw new Error('The staged Node runtime has an unexpected manifest')
  }
  const files = {
    nodeSha256: 'bin/node',
    serverSha256: 'server/dist/bin.mjs',
    exchangeSha256: 'server/dist/rename-exchange.node',
    sealSha256: 'server/dist/seal-executable.node',
    enrollmentSha256: 'server/dist/credential-enroll.mjs',
    recoverySha256: 'server/dist/recovery-export.mjs',
    cliSha256: 'bin/agent-workspace-node.mjs',
    licenseSha256: 'licenses/Node-LICENSE'
  }
  for (const [key, path] of Object.entries(files)) {
    if (
      !/^[a-f0-9]{64}$/u.test(manifest[key]) ||
      !(await lstat(join(source, path))).isFile() ||
      (await sha256(join(source, path))) !== manifest[key]
    ) {
      throw new Error(`The staged Node runtime failed verification: ${path}`)
    }
  }
  async function checkLinks(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path)
        const inside = relative(source, target)
        if (inside === '..' || inside.startsWith(`..${sep}`)) {
          throw new Error(`The staged Node runtime links outside its directory: ${path}`)
        }
      } else if (entry.isDirectory()) {
        await checkLinks(path)
      }
    }
  }
  await checkLinks(source)
  await cp(source, join(context.appOutDir, 'resources', 'node-linux'), {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true
  })
}

export default async function applyProductionFuses(context) {
  await includeOptionalLinuxNodeRuntime(context)
  await flipFuses(executablePath(context), {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin' && context.arch === 3,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  })
}
