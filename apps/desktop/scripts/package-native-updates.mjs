import { spawnSync } from 'node:child_process'
import { isIP } from 'node:net'
import process from 'node:process'
import { URL } from 'node:url'
import { build } from 'electron-builder'

const target = process.argv[2]
const targets = {
  linux: { linux: ['AppImage', 'deb', 'rpm'], x64: true },
  mac: { mac: ['dmg', 'zip'], [process.arch]: true },
  windows: { win: ['nsis'], x64: true }
}

if (!Object.hasOwn(targets, target)) {
  throw new Error('usage: package-native-updates.mjs linux|mac|windows')
}

const url = process.env.AGENT_WORKSPACE_UPDATE_BUILD_URL
const channel = process.env.AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL
if (!url || !channel) {
  throw new Error(
    'AGENT_WORKSPACE_UPDATE_BUILD_URL and AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL are required'
  )
}
if (!['stable', 'beta'].includes(channel)) {
  throw new Error('AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL must be stable or beta')
}
let parsedUrl
try {
  parsedUrl = new URL(url)
} catch {
  throw new Error('AGENT_WORKSPACE_UPDATE_BUILD_URL must be a valid HTTPS URL')
}
if (
  url !== url.trim() ||
  parsedUrl.protocol !== 'https:' ||
  parsedUrl.username ||
  parsedUrl.password ||
  parsedUrl.search ||
  parsedUrl.hash ||
  isIP(parsedUrl.hostname) !== 0 ||
  parsedUrl.hostname === 'localhost' ||
  parsedUrl.hostname.endsWith('.localhost')
) {
  throw new Error('AGENT_WORKSPACE_UPDATE_BUILD_URL must be a public HTTPS directory URL')
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
if (target === 'mac' || target === 'windows') run(['--workspace-root', 'build:node'])
run(['exec', 'electron-vite', 'build'])
await build({
  ...targets[target],
  publish: 'never',
  config: {
    publish: [{ provider: 'generic', url, channel, publishAutoUpdate: true }],
    forceCodeSigning: process.env.AGENT_WORKSPACE_FORCE_CODE_SIGNING === 'true'
  }
})

function run(arguments_) {
  const result = spawnSync(pnpm, arguments_, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
