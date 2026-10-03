import { expect, it, vi } from 'vitest'
import { NodeSidecar } from './node-sidecar'

function fixture() {
  const sidecar = Object.create(NodeSidecar.prototype) as NodeSidecar
  const close = vi.fn()
  const resync = vi.fn()
  const attachment = { socket: { close }, windowId: 'source', suspended: false, resync }
  const sockets = new Map([['terminal', attachment]])
  Object.assign(sidecar, { terminalSockets: sockets, remoteTerminals: new Map() })
  return { sidecar, attachment, sockets, close, resync }
}

it('quiesces a local terminal and restores source delivery after a failed close', () => {
  const test = fixture()
  const transfer = test.sidecar.suspendLocalTerminalEvents('source', ['terminal'])
  expect(transfer.isCurrent()).toBe(true)
  expect(test.attachment.suspended).toBe(true)
  transfer.rollback()
  expect(test.attachment.suspended).toBe(false)
  expect(test.resync).toHaveBeenCalledOnce()
  expect(test.close).not.toHaveBeenCalled()
})

it('closes only the source event socket after commit without terminating the PTY', () => {
  const test = fixture()
  const transfer = test.sidecar.suspendLocalTerminalEvents('source', ['terminal'])
  transfer.finalize()
  expect(test.sockets.has('terminal')).toBe(false)
  expect(test.close).toHaveBeenCalledOnce()
  expect(test.resync).not.toHaveBeenCalled()
})

it('rejects missing, remote, and changed terminal owners without resuming another socket', () => {
  const test = fixture()
  expect(() => test.sidecar.suspendLocalTerminalEvents('other', ['terminal'])).toThrow('owner')
  expect(test.attachment.suspended).toBe(false)
  const transfer = test.sidecar.suspendLocalTerminalEvents('source', ['terminal'])
  test.sockets.delete('terminal')
  expect(transfer.isCurrent()).toBe(false)
  expect(() => transfer.rollback()).toThrow('safely')
  expect(test.resync).not.toHaveBeenCalled()

  const remote = fixture()
  Object.assign(remote.sidecar, { remoteTerminals: new Map([['terminal', {}]]) })
  expect(() => remote.sidecar.suspendLocalTerminalEvents('source', ['terminal']))
    .toThrow('Remote terminal')
})
