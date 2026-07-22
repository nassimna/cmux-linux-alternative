#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

const SYSTEM_ENVIRONMENT = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  TERM: 'xterm-256color'
})
const COMMAND_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 64 * 1024

const requestedTmux = process.argv[2]
const requirePersistentTransport = process.argv[3] === '--persistent'
if (!requestedTmux) {
  fail('usage: m7-hermetic-remote.mjs /absolute/path/to/tmux [--persistent]')
}
if (process.argv[3] && !requirePersistentTransport) {
  fail('the optional fixture mode is invalid')
}

const fixtureRoot = await mkdtemp(join(tmpdir(), 'cmux-m7-remote-'))
await chmod(fixtureRoot, 0o700)
let sshd
let cleanupRemoteSession
let networkLossEvidence
try {
  const tmux = await trustedExecutable(requestedTmux, false)
  const ssh = await trustedExecutable('/usr/bin/ssh', true)
  const sshdExecutable = await trustedFirstExecutable(['/usr/bin/sshd', '/usr/sbin/sshd'], true)
  const sshKeygen = await trustedExecutable('/usr/bin/ssh-keygen', true)
  const sshKeyscan = await trustedExecutable('/usr/bin/ssh-keyscan', true)
  const port = await reserveLoopbackPort()
  const username = userInfo().username
  const hostKey = join(fixtureRoot, 'host-ed25519')
  const clientKey = join(fixtureRoot, 'client-ed25519')
  const authorizedKeys = join(fixtureRoot, 'authorized_keys')
  const knownHosts = join(fixtureRoot, 'known_hosts')
  const config = join(fixtureRoot, 'sshd_config')
  const pidFile = join(fixtureRoot, 'sshd.pid')

  await command(sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
  await command(sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey])
  const publicKey = await readFile(`${clientKey}.pub`, 'utf8')
  await writeFile(
    authorizedKeys,
    `no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc ${publicKey.trim()}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  )
  const remotePath = `${dirname(tmux)}:/usr/bin:/bin`
  await writeFile(
    config,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${hostKey}`,
      `PidFile ${pidFile}`,
      `AuthorizedKeysFile ${authorizedKeys}`,
      `AllowUsers ${username}`,
      'AuthenticationMethods publickey',
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      username === 'root' ? 'PermitRootLogin prohibit-password' : 'PermitRootLogin no',
      'StrictModes no',
      'AllowAgentForwarding no',
      'AllowTcpForwarding no',
      'X11Forwarding no',
      'PermitTunnel no',
      'GatewayPorts no',
      'PermitUserEnvironment no',
      'UseDNS no',
      'PrintMotd no',
      `SetEnv PATH=${remotePath}`,
      'LogLevel ERROR',
      ''
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  )
  await command(sshdExecutable, ['-t', '-f', config])
  sshd = spawn(sshdExecutable, ['-D', '-e', '-f', config], {
    env: SYSTEM_ENVIRONMENT,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const sshdErrors = boundedStream(sshd.stderr)
  await waitForPort(port, sshd)

  const scan = await command(sshKeyscan, [
    '-T',
    '5',
    '-p',
    String(port),
    '-t',
    'ed25519',
    '127.0.0.1'
  ])
  const hostRows = scan.stdout.split('\n').filter((line) => line && !line.startsWith('#'))
  if (hostRows.length !== 1 || !hostRows[0].includes(' ssh-ed25519 ')) {
    throw new Error('the fixture did not produce one exact Ed25519 host key')
  }
  await writeFile(knownHosts, `${hostRows[0]}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })

  const baseArguments = [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-i',
    clientKey,
    '-p',
    String(port),
    '-l',
    username,
    '--',
    '127.0.0.1'
  ]
  const remote = (arguments_) => command(ssh, [...baseArguments, ...arguments_])
  const version = (await remote(['tmux', '-V'])).stdout.trim()
  if (!/^tmux (?:[4-9]|3\.[2-9])[^\s]*$/u.test(version)) {
    throw new Error('the remote tmux version is unsupported')
  }

  const sessionName = `cmux-create-${String(process.pid)}`
  cleanupRemoteSession = async () => {
    await remote(['tmux', 'kill-session', '-t', `=${sessionName}`]).catch(() => undefined)
  }
  const createClient = spawn(ssh, ['-tt', ...baseArguments, `tmux new-session -s ${sessionName}`], {
    env: SYSTEM_ENVIRONMENT,
    stdio: ['pipe', 'ignore', 'pipe']
  })
  const createErrors = boundedStream(createClient.stderr)
  await waitForLiveChild(createClient, createErrors)
  if (requirePersistentTransport) await detachTmuxClient(createClient)
  else await terminate(createClient)
  if (requirePersistentTransport) {
    await remote(['tmux', 'has-session', '-t', `=${sessionName}`])
    const attachClient = spawn(
      ssh,
      ['-tt', ...baseArguments, `tmux attach-session -t ${sessionName}`],
      { env: SYSTEM_ENVIRONMENT, stdio: ['pipe', 'ignore', 'pipe'] }
    )
    const attachErrors = boundedStream(attachClient.stderr)
    await waitForLiveChild(attachClient, attachErrors)
    const interruption = await interruptSshdConnection(pidFile, attachClient, attachErrors)
    await remote(['tmux', 'has-session', '-t', `=${sessionName}`])
    const recoveredClient = spawn(
      ssh,
      ['-tt', ...baseArguments, `tmux attach-session -t ${sessionName}`],
      { env: SYSTEM_ENVIRONMENT, stdio: ['pipe', 'ignore', 'pipe'] }
    )
    const recoveredErrors = boundedStream(recoveredClient.stderr)
    await waitForLiveChild(recoveredClient, recoveredErrors)
    await detachTmuxClient(recoveredClient)
    await remote(['tmux', 'has-session', '-t', `=${sessionName}`])
    networkLossEvidence = {
      interruptedServerProcesses: interruption.killedProcesses,
      originalTransportExited: true,
      exactSessionReattached: true
    }
  }
  // Match SshLaunchPlan exactly: OpenSSH receives one internally owned remote
  // command string, then the remote login shell interprets its fixed quoting.
  const discovered = (await remote(["tmux list-sessions -F '#{session_name}'"])).stdout
    .split('\n')
    .filter(Boolean)
  if (
    discovered.filter((name) => name === sessionName).length !== 1 ||
    discovered.some((name) => !/^[A-Za-z0-9_.-]{1,64}$/u.test(name))
  ) {
    throw new Error('the exact production discovery command did not return bare tmux names')
  }
  await cleanupRemoteSession()
  cleanupRemoteSession = undefined

  const networkLossCovered =
    networkLossEvidence?.originalTransportExited === true &&
    networkLossEvidence?.exactSessionReattached === true
  const exactCreatedSessionCount = discovered.filter((name) => name === sessionName).length

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      scope: 'hermetic-transport-fixture',
      host: 'ipv4-loopback',
      hostKeyAlgorithm: 'ssh-ed25519',
      tmuxVersion: version,
      strictHostKeyAuthentication: true,
      publicKeyAuthentication: true,
      fixedTmuxCreateStayedLive: true,
      exactRemoteCommandDiscovery: true,
      attachDetachReconnectCovered: requirePersistentTransport,
      networkLossCovered,
      networkLossEvidence: networkLossEvidence ?? null,
      exactCreatedSessionCount,
      qualificationComplete:
        requirePersistentTransport && networkLossCovered && exactCreatedSessionCount === 1
    })}\n`
  )
  if (sshd.exitCode !== null) {
    throw new Error(`the hermetic sshd exited unexpectedly: ${await sshdErrors}`)
  }
} finally {
  if (cleanupRemoteSession) await cleanupRemoteSession()
  if (sshd) await terminate(sshd)
  await rm(fixtureRoot, { force: true, recursive: true })
}

async function trustedExecutable(path, requireRoot) {
  if (!resolve(path).startsWith('/') || basename(path).length === 0) {
    throw new Error('an executable path is invalid')
  }
  const canonical = await realpath(path)
  const metadata = await stat(canonical)
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o111) === 0 ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.nlink !== 1 ||
    (requireRoot && metadata.uid !== 0)
  ) {
    throw new Error(`an executable failed authority checks: ${basename(path)}`)
  }
  return canonical
}

async function trustedFirstExecutable(paths, requireRoot) {
  for (const path of paths) {
    try {
      return await trustedExecutable(path, requireRoot)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
  throw new Error('a required executable is unavailable')
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  )
  if (port === 0) throw new Error('a loopback fixture port is unavailable')
  return port
}

async function command(
  executable,
  arguments_,
  timeoutMs = COMMAND_TIMEOUT_MS,
  environment = SYSTEM_ENVIRONMENT
) {
  const child = spawn(executable, arguments_, {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout = boundedStream(child.stdout)
  const stderr = boundedStream(child.stderr)
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const result = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  clearTimeout(timeout)
  const output = { ...result, stdout: await stdout, stderr: await stderr }
  if (output.code !== 0) {
    throw new Error(
      `fixture command ${basename(executable)} failed with code ${String(output.code)}`
    )
  }
  return output
}

function boundedStream(stream) {
  return new Promise((resolvePromise) => {
    let value = ''
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk) => {
      if (value.length < OUTPUT_LIMIT) value += chunk.slice(0, OUTPUT_LIMIT - value.length)
    })
    stream?.on('end', () => resolvePromise(value))
    if (!stream) resolvePromise('')
  })
}

async function waitForPort(port, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error('the hermetic sshd could not start')
    const connected = await new Promise((resolvePromise) => {
      const socket = new Socket()
      socket.setTimeout(100)
      socket.once('connect', () => {
        socket.destroy()
        resolvePromise(true)
      })
      socket.once('error', () => resolvePromise(false))
      socket.once('timeout', () => {
        socket.destroy()
        resolvePromise(false)
      })
      socket.connect(port, '127.0.0.1')
    })
    if (connected) return
    await delay(100)
  }
  throw new Error('the hermetic sshd did not become reachable')
}

async function waitForLiveChild(child, errors) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (child.exitCode !== null) {
      await errors
      throw new Error('the fixed remote tmux operation exited early')
    }
    await delay(100)
  }
}

async function terminate(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(2_000).then(() => false)
  ])
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise((resolvePromise) => child.once('exit', resolvePromise))
  }
}

async function detachTmuxClient(child) {
  if (!child.stdin || child.exitCode !== null) {
    throw new Error('the fixed remote tmux client was unavailable for detach')
  }
  child.stdin.write('\u0002d')
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(2_000).then(() => false)
  ])
  if (!exited || child.exitCode !== 0) {
    await terminate(child)
    throw new Error('the fixed remote tmux client did not detach cleanly')
  }
}

async function interruptSshdConnection(pidFile, client, errors) {
  const masterPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
  if (!Number.isSafeInteger(masterPid) || masterPid <= 1) {
    throw new Error('the hermetic sshd master pid is invalid')
  }
  let descendants = []
  for (let attempt = 0; attempt < 20; attempt += 1) {
    descendants = await processDescendants(masterPid)
    if (descendants.length > 0) break
    await delay(50)
  }
  if (descendants.length === 0) {
    throw new Error('the live SSH connection had no server-owned process to interrupt')
  }
  for (const pid of descendants.reverse()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) {
        throw error
      }
    }
  }
  const exited = await Promise.race([
    new Promise((resolvePromise) => client.once('exit', () => resolvePromise(true))),
    delay(2_000).then(() => false)
  ])
  if (!exited || client.exitCode === 0) {
    await terminate(client)
    throw new Error(`server-side interruption did not fail the SSH transport: ${await errors}`)
  }
  return { killedProcesses: descendants.length }
}

async function processDescendants(parentPid) {
  const childrenPath = `/proc/${String(parentPid)}/task/${String(parentPid)}/children`
  let row
  try {
    row = await readFile(childrenPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const direct = row
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 1)
  const nested = []
  for (const child of direct) nested.push(...(await processDescendants(child)))
  return [...direct, ...nested]
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}
