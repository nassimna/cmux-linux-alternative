import { spawnSync } from 'node:child_process'
import { isIP } from 'node:net'
import process from 'node:process'
import { URL } from 'node:url'

const target = process.argv[2]
const targets = {
  mac: ['--mac', 'dmg', 'zip', '--x64'],
  windows: ['--win', 'nsis', '--x64']
}

if (!Object.hasOwn(targets, target)) {
  throw new Error('usage: package-native-updates.mjs mac|windows')
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
run(['exec', 'electron-vite', 'build'])
const builderArguments = [
  'exec',
  'electron-builder',
  ...targets[target],
  '--publish',
  'never',
  '-c.publish.provider=generic',
  `-c.publish.url=${url}`,
  `-c.publish.channel=${channel}`,
  '-c.publish.publishAutoUpdate=true'
]
if (process.env.AGENT_WORKSPACE_FORCE_CODE_SIGNING === 'true') {
  builderArguments.push('-c.forceCodeSigning=true')
}
run(builderArguments)

function run(arguments_) {
  const result = spawnSync(pnpm, arguments_, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
