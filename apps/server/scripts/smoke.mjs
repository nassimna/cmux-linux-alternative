import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const token = randomBytes(32).toString('hex')
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))],
  {
    env: {
      ...process.env,
      AGENT_WORKSPACE_SERVER_TOKEN: token,
      AGENT_WORKSPACE_SERVER_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }
)

let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (data) => {
  stderr += data
})

try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not become ready')), 10_000)
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data) => {
      output += data
      const match = output.match(/\[server\] listening on 127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(Number(match[1]))
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Server exited before ready (${code}): ${stderr}`))
    })
  })

  const url = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const identity = await fetch(`${url}/v1/system/identify`, { headers })
  if (!identity.ok || !(await identity.json()).capabilities.includes('terminal.attach')) {
    throw new Error('Packaged server identity check failed')
  }

  const created = await fetch(`${url}/v1/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rows: 24,
      cols: 80,
      command: [process.execPath, '-e', 'process.stdout.write("bundle-pty-ready")']
    })
  })
  if (!created.ok) throw new Error(`Terminal creation failed: ${created.status}`)
  const { terminal } = await created.json()
  const deadline = Date.now() + 10_000
  let attached
  do {
    const response = await fetch(`${url}/v1/terminals/${terminal.id}`, { headers })
    if (!response.ok) throw new Error(`Terminal attach failed: ${response.status}`)
    attached = await response.json()
    if (attached.terminal.exited) break
    await delay(10)
  } while (Date.now() < deadline)
  if (!attached.terminal.exited) throw new Error('Terminal did not exit')
  const output = Buffer.concat(attached.output.map((chunk) => Buffer.from(chunk.data, 'base64')))
  if (!output.includes(Buffer.from('bundle-pty-ready')) || attached.terminal.exitCode !== 0) {
    throw new Error('Packaged server lost PTY output or exit status')
  }
  console.log('Packaged Node server authenticated and ran a real PTY')
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
