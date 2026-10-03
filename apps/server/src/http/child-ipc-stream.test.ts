import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { createOwnerIpcStream } from '@agent-workspace/client-runtime'
import { expect, it } from 'vitest'

it('carries owner frames through a real inherited child IPC pipe', async () => {
  const helper = new URL(
    '../../../../packages/client-runtime/src/child-ipc-stream.ts',
    import.meta.url
  )
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `
    import { createOwnerIpcStream } from ${JSON.stringify(helper.href)};
    const stream = createOwnerIpcStream({
      send: process.send.bind(process), connected: process.connected,
      on: process.on.bind(process), removeListener: process.removeListener.bind(process)
    });
    stream.on('data', frame => stream.write(frame));
  `
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], cwd: fileURLToPath(new URL('../../', helper)) }
  )
  const stream = createOwnerIpcStream(child)
  stream.on('error', () => {})
  try {
    const response = once(stream, 'data')
    stream.write(Buffer.from('private owner request'))
    expect((await response)[0]).toEqual(Buffer.from('private owner request'))
  } finally {
    stream.destroy()
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
}, 15_000)

it('closes the owner transport on malformed messages and disconnect', async () => {
  const endpoint = Object.assign(new EventEmitter(), {
    connected: true,
    send: (_message: unknown, callback: (error: Error | null) => void) => {
      callback(null)
      return true
    }
  })
  const stream = createOwnerIpcStream(endpoint)
  const rejected = once(stream, 'error')
  endpoint.emit('message', { channel: 'agent-workspace-owner-v1', frame: '!!' })
  expect((await rejected)[0]).toHaveProperty('message', 'Invalid window owner IPC frame')
  const disconnected = createOwnerIpcStream(endpoint)
  const failed = once(disconnected, 'error')
  endpoint.emit('disconnect')
  expect((await failed)[0]).toHaveProperty('message', 'Window owner IPC disconnected')
})
