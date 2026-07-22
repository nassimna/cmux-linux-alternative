/* global __dirname */

const { app, dialog } = require('electron')
const { Buffer } = require('node:buffer')
const { appendFileSync } = require('node:fs')
const net = require('node:net')
const { resolve } = require('node:path')
const process = require('node:process')

const isolatedUserData = process.env.AGENT_WORKSPACE_E2E_USER_DATA_DIR
if (isolatedUserData) app.setPath('userData', resolve(isolatedUserData))

const raw = process.env.AGENT_WORKSPACE_E2E_DIALOG_RESPONSES
if (!raw) throw new Error('Missing AGENT_WORKSPACE_E2E_DIALOG_RESPONSES')
const responses = JSON.parse(raw)
const savePaths = [...(responses.savePaths ?? [])]
const openPaths = [...(responses.openPaths ?? [])]
const messageResponses = [...(responses.messageResponses ?? [])]
const tracePath = responses.tracePath
globalThis.__m5ControlRequests = []
globalThis.__m5AcknowledgeResponses = []
const pendingAcknowledgeIds = new Set()
const inboundBuffers = new WeakMap()
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
        if (value.command === 'browserAutomation.providerAcknowledge') {
          pendingAcknowledgeIds.add(value.id)
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
        if (pendingAcknowledgeIds.delete(value?.id)) {
          globalThis.__m5AcknowledgeResponses.push(redact(value))
          if (tracePath) {
            appendFileSync(
              tracePath,
              `${JSON.stringify({ kind: 'wire', acknowledgeResponse: redact(value) })}\n`
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

const trace = (kind, options, result) => {
  if (!tracePath) return
  appendFileSync(tracePath, `${JSON.stringify({ kind, title: options?.title, result })}\n`)
}

dialog.showSaveDialog = async (_window, options) => {
  const filePath = savePaths.shift()
  const result = filePath ? { canceled: false, filePath } : { canceled: true }
  trace('save', options, result)
  return result
}
dialog.showOpenDialog = async (_window, options) => {
  const filePath = openPaths.shift()
  const result = filePath
    ? { canceled: false, filePaths: [filePath] }
    : { canceled: true, filePaths: [] }
  trace('open', options, result)
  return result
}
dialog.showMessageBox = async (_window, options) => {
  const response = messageResponses.shift() ?? options?.cancelId ?? 0
  const result = { checkboxChecked: false, response }
  trace('message', options, result)
  return result
}

require(resolve(__dirname, '../../out/main/index.js'))
