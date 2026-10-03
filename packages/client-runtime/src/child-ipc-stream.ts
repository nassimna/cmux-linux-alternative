import { Duplex } from 'node:stream'

type Endpoint = {
  send(
    message: { channel: string; frame: string },
    callback: (error: Error | null) => void
  ): boolean
  connected: boolean
  on(event: string, listener: (...arguments_: unknown[]) => void): unknown
  removeListener(event: string, listener: (...arguments_: unknown[]) => void): unknown
}
const CHANNEL = 'agent-workspace-owner-v1'
const MAX_BYTES = 4_096

/** Carry the existing bounded owner protocol over a private inherited Windows IPC pipe. */
export function createOwnerIpcStream(endpoint: Endpoint): Duplex {
  const message = (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.keys(value).length !== 2 ||
      !('channel' in value) ||
      value.channel !== CHANNEL ||
      !('frame' in value) ||
      typeof value.frame !== 'string' ||
      value.frame.length > 5_464
    ) {
      stream.destroy(new Error('Invalid window owner IPC frame'))
      return
    }
    const frame = Buffer.from(value.frame, 'base64')
    if (
      frame.length === 0 ||
      frame.length > MAX_BYTES ||
      frame.toString('base64') !== value.frame
    ) {
      stream.destroy(new Error('Invalid window owner IPC frame'))
      return
    }
    stream.push(frame)
  }
  const disconnect = () => stream.destroy(new Error('Window owner IPC disconnected'))
  const stream = new Duplex({
    read() {
      // The inherited IPC pipe supplies chunks through its message event.
    },
    write(chunk: Buffer, _encoding, done) {
      if (!endpoint.connected || chunk.length === 0 || chunk.length > MAX_BYTES) {
        done(new Error('Window owner IPC is unavailable'))
        return
      }
      endpoint.send({ channel: CHANNEL, frame: chunk.toString('base64') }, done)
    },
    destroy(error, done) {
      endpoint.removeListener('message', message)
      endpoint.removeListener('disconnect', disconnect)
      done(error)
    }
  })
  endpoint.on('message', message)
  endpoint.on('disconnect', disconnect)
  return stream
}
