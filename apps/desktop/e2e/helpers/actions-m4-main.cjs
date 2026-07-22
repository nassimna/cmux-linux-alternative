const { dialog } = require('electron')
const { Buffer } = require('node:buffer')
const { appendFileSync } = require('node:fs')
const net = require('node:net')
const { resolve } = require('node:path')
const process = require('node:process')
const { setTimeout } = require('node:timers')

const configuration = JSON.parse(process.env.AGENT_WORKSPACE_M4_DIALOGS ?? '{}')
const messageResponses = [...(configuration.messageResponses ?? [])]
const tracePath = configuration.tracePath
globalThis.__agentWorkspaceM4ControlRequests = []

const originalWrite = net.Socket.prototype.write
net.Socket.prototype.write = function patchedWrite(chunk, ...rest) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (typeof value?.command === 'string') {
        globalThis.__agentWorkspaceM4ControlRequests.push(value)
        if (
          value.command === 'desktopAction.acknowledge' &&
          globalThis.__agentWorkspaceM4DelayNextAcknowledgement
        ) {
          globalThis.__agentWorkspaceM4DelayNextAcknowledgement = false
          globalThis.__agentWorkspaceM4DelayedAcknowledgement = value
          setTimeout(() => originalWrite.call(this, chunk, ...rest), 5_000)
          return true
        }
      }
    } catch {
      // Authentication and control writes are line framed; incomplete/non-JSON writes are ignored.
    }
  }
  return originalWrite.call(this, chunk, ...rest)
}

dialog.showMessageBox = async (_window, options) => {
  const response = messageResponses.shift() ?? options?.cancelId ?? 1
  const result = { checkboxChecked: false, response }
  if (tracePath) {
    appendFileSync(
      tracePath,
      `${JSON.stringify({
        kind: 'message',
        title: options?.title,
        response,
        detailLines: String(options?.detail ?? '').split('\n').length
      })}\n`
    )
  }
  return result
}

require(resolve(process.cwd(), 'out/main/index.js'))
