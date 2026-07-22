/* global __dirname */

const { appendFileSync } = require('node:fs')
const { Buffer } = require('node:buffer')
const console = require('node:console')
const { app, dialog } = require('electron')
const net = require('node:net')
const { resolve } = require('node:path')
const process = require('node:process')

const tracePath = process.env.AGENT_WORKSPACE_E2E_MAIN_TRACE
globalThis.__m5ControlRequests = []
globalThis.__m5AcknowledgeResponses = []
globalThis.__m5ProviderDeliveries = []
globalThis.__m5Faults = { dropProviderHeartbeats: false }
const pendingAcknowledgeIds = new Set()
const pendingCommands = new Map()
const inboundBuffers = new WeakMap()
let providerSocket
const redact = (value) => {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /token|secret|content|dataBase64/iu.test(key) ? '[redacted]' : redact(entry)
    ])
  )
}
const originalWrite = net.Socket.prototype.write
net.Socket.prototype.write = function patchedWrite(chunk, ...rest) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (typeof value?.command === 'string') {
        globalThis.__m5ControlRequests.push(value)
        pendingCommands.set(value.id, value.command)
        if (value.command.startsWith('desktopProvider.')) providerSocket = this
        if (value.command === 'browserAutomation.providerAcknowledge') {
          pendingAcknowledgeIds.add(value.id)
        }
        if (
          value.command === 'desktopProvider.heartbeat' &&
          globalThis.__m5Faults.dropProviderHeartbeats
        ) {
          return true
        }
      }
    } catch {
      // Control writes are newline-framed; partial/non-JSON writes are ignored.
    }
  }
  return originalWrite.call(this, chunk, ...rest)
}
const originalEmit = net.Socket.prototype.emit
net.Socket.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'data' && args[0] !== undefined) {
    const prior = inboundBuffers.get(this) ?? ''
    const incoming = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0])
    const lines = `${prior}${incoming}`.split('\n')
    inboundBuffers.set(this, lines.pop() ?? '')
    for (const line of lines) {
      try {
        const value = JSON.parse(line)
        const command = pendingCommands.get(value?.id)
        pendingCommands.delete(value?.id)
        if (
          command === 'browserAutomation.providerPoll' &&
          value?.ok === true &&
          value?.result?.request
        ) {
          globalThis.__m5ProviderDeliveries.push(redact(value.result.request))
        }
        if (pendingAcknowledgeIds.delete(value?.id)) {
          globalThis.__m5AcknowledgeResponses.push(redact(value))
          if (tracePath) {
            appendFileSync(
              tracePath,
              `${JSON.stringify({ level: 'wire', acknowledgeResponse: redact(value) })}\n`
            )
          }
        }
      } catch {
        // Ignore non-JSON frames; the production client owns protocol validation.
      }
    }
  }
  return originalEmit.call(this, event, ...args)
}
globalThis.__m5SetDropProviderHeartbeats = (drop) => {
  globalThis.__m5Faults.dropProviderHeartbeats = Boolean(drop)
}
globalThis.__m5CloseProviderTransport = () => {
  if (!providerSocket || providerSocket.destroyed) return false
  providerSocket.destroy(new Error('M5 deterministic provider transport disconnect'))
  return true
}
if (process.env.AGENT_WORKSPACE_E2E_ALLOW_ATTACH === '1') {
  dialog.showMessageBox = async () => ({ checkboxChecked: false, response: 1 })
}
for (const level of ['error', 'warn']) {
  const original = console[level]
  console[level] = (...values) => {
    if (tracePath) {
      const rendered = values.map((value) =>
        value instanceof Error ? (value.stack ?? value.message) : String(value)
      )
      appendFileSync(tracePath, `${JSON.stringify({ level, rendered })}\n`)
    }
    original(...values)
  }
}

app.on('web-contents-created', (_event, contents) => {
  const originalCapturePage = contents.capturePage.bind(contents)
  contents.capturePage = async (...args) => {
    const captured = await originalCapturePage(...args)
    if (tracePath) {
      appendFileSync(
        tracePath,
        `${JSON.stringify({ level: 'capture', requested: args[0], returned: captured.getSize() })}\n`
      )
    }
    return captured
  }
})

require(resolve(__dirname, '../../out/main/index.js'))
