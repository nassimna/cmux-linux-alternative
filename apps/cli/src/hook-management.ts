import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseToml } from 'smol-toml'
import { applyEdits, findNodeAtLocation, modify, parseTree, type Node as JsonNode } from 'jsonc-parser/lib/esm/main.js'

const MAX_BYTES = 64 * 1024
type Agent = 'codex' | 'claude'
type Status = 'installed' | 'conflict' | 'not installed'

interface State {
  version: 1
  integration: Agent
  configPath: string
  configExisted: boolean
  managed: unknown
  priorCodexValue?: string
  insertedCodexText?: string
  priorClaudeNotificationExisted?: boolean
  claudeManagedIndex?: number
  priorClaudeManagedCount?: number
}

interface Paths { config: string; state: string; backup: string }

function failure(message: string): never { throw new Error(message) }

function paths(agent: Agent, home: string = process.env.HOME || homedir()): Paths {
  if (!isAbsolute(home)) failure('A user home directory is required')
  const stateHome = process.env.XDG_STATE_HOME || join(home, '.local', 'state')
  if (!isAbsolute(stateHome)) failure('XDG_STATE_HOME must be absolute')
  const root = join(stateHome, 'agent-workspace', 'hooks')
  return {
    config: join(home, agent === 'codex' ? '.codex/config.toml' : '.claude/settings.json'),
    state: join(root, `${agent}.json`),
    backup: join(root, `${agent}.backup`)
  }
}

async function ensureParent(path: string): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await validateParent(parent)
}

async function validateParent(parent: string): Promise<void> {
  const info = await lstat(parent)
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (await realpath(parent)) !== resolve(parent)) {
    failure('The hook directory must be a real user-owned directory')
  }
}

async function readOptional(path: string, secure = false): Promise<{ existed: boolean; text: string }> {
  const parent = dirname(path)
  const parentInfo = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (parentInfo) await validateParent(parent)
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return { existed: false, text: '' }
  if (!info.isFile() || info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) || info.size > MAX_BYTES ||
      (secure && ((info.mode & 0o077) !== 0 || info.nlink !== 1))) {
    failure('The hook file must be a bounded user-owned regular file')
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const checked = await file.stat()
    if (!checked.isFile() || checked.size > MAX_BYTES ||
        (process.getuid && checked.uid !== process.getuid()) ||
        (secure && ((checked.mode & 0o077) !== 0 || checked.nlink !== 1)) ||
        checked.dev !== info.dev || checked.ino !== info.ino) {
      failure('The hook file changed while reading')
    }
    const bytes = await file.readFile()
    if (bytes.length > MAX_BYTES) failure('The hook file exceeds 64 KiB')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { existed: true, text }
  } finally { await file.close() }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  if (Buffer.byteLength(text) > MAX_BYTES) failure('The hook file exceeds 64 KiB')
  await ensureParent(path)
  await readOptional(path) // Reject symlink and wrong owner before replacing.
  const temporary = join(dirname(path), `.agent-workspace-${randomUUID()}.tmp`)
  const file = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    await file.writeFile(text)
    await file.sync()
  } finally { await file.close() }
  try { await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
}

async function writeBackup(path: string, text: string): Promise<void> {
  await ensureParent(path)
  if ((await readOptional(path, true)).existed)
    failure('A hook backup already exists; refusing to overwrite it')
  const temporary = join(dirname(path), `.agent-workspace-${randomUUID()}.tmp`)
  const file = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { await file.writeFile(text); await file.sync() }
  finally { await file.close() }
  try { await link(temporary, path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      failure('A hook backup was created concurrently')
    throw error
  } finally { await rm(temporary, { force: true }) }
}

function parseCodex(text: string): Record<string, unknown> {
  try { return parseToml(text) }
  catch { return failure('The agent configuration is malformed; no files were changed') }
}

function parseClaude(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const value: unknown = JSON.parse(text)
    const tree = parseTree(text)
    if (value && typeof value === 'object' && !Array.isArray(value) && tree && !duplicateJsonKey(tree))
      return value as Record<string, unknown>
  } catch { /* malformed */ }
  return failure('The agent configuration is malformed; no files were changed')
}

function duplicateJsonKey(node: JsonNode): boolean {
  if (node.type === 'object') {
    const names = new Set<string>()
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value
      if (typeof key !== 'string' || names.has(key)) return true
      names.add(key)
    }
  }
  return (node.children ?? []).some(duplicateJsonKey)
}

function editClaude(text: string, path: (string | number)[], value: unknown): string {
  const source = text || '{}'
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const edits = modify(source, path, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol }
  })
  const output = applyEdits(source, edits)
  parseClaude(output)
  return output
}

function notificationNode(text: string): JsonNode {
  const tree = parseTree(text)
  const node = tree && findNodeAtLocation(tree, ['hooks', 'Notification'])
  if (!node || node.type !== 'array') failure('The Claude Notification hooks are ambiguous')
  return node
}

function appendClaudeEntry(text: string, managed: unknown): string {
  const array = notificationNode(text)
  const last = array.children?.at(-1)
  const offset = last ? last.offset + last.length : array.offset + 1
  const addition = `${last ? ', ' : ''}${JSON.stringify(managed)}`
  const output = text.slice(0, offset) + addition + text.slice(offset)
  parseClaude(output)
  return output
}

function removeClaudeEntry(text: string, index: number): string {
  const array = notificationNode(text)
  const children = array.children ?? []
  const current = children[index]
  if (!current) failure('The managed Claude entry moved')
  const before = children[index - 1]
  const after = children[index + 1]
  let start: number
  let end: number
  if (before) {
    start = before.offset + before.length
    end = current.offset + current.length
    if (!/^\s*,\s*$/u.test(text.slice(start, current.offset)))
      failure('The Claude Notification hooks are ambiguous')
  } else if (after) {
    start = current.offset
    end = after.offset
    if (!/^\s*,\s*$/u.test(text.slice(current.offset + current.length, end)))
      failure('The Claude Notification hooks are ambiguous')
  } else {
    start = current.offset
    end = current.offset + current.length
  }
  const output = text.slice(0, start) + text.slice(end)
  parseClaude(output)
  return output
}

interface NotifySpan { start: number; valueStart: number; valueEnd: number; lineEnd: number }

/** Only edit an unambiguous, single-line root assignment. The parser validates semantics. */
function rootNotifySpan(text: string, document: Record<string, unknown>): NotifySpan | undefined {
  let offset = 0
  let match: NotifySpan | undefined
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const body = line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/u, '') : line
    if (/^[ \t]*\[/u.test(body)) break
    const found = /^([ \t]*notify[ \t]*=[ \t]*)(.*)$/u.exec(body)
    if (found) {
      if (match) failure('The Codex notify entry is ambiguous')
      const prefix = found[1]!
      const rhs = found[2]!
      let quote: 'single' | 'double' | undefined
      let escaped = false
      let comment = rhs.length
      for (let index = 0; index < rhs.length; index++) {
        const char = rhs[index]!
        if (escaped) { escaped = false; continue }
        if (quote === 'double' && char === '\\') { escaped = true; continue }
        if (!quote && char === '#') { comment = index; break }
        if (char === '"' && quote !== 'single') quote = quote === 'double' ? undefined : 'double'
        if (char === "'" && quote !== 'double') quote = quote === 'single' ? undefined : 'single'
      }
      const value = rhs.slice(0, comment).trimEnd()
      try {
        const parsed = parseToml(`notify = ${value}`) as Record<string, unknown>
        if (JSON.stringify(parsed.notify) !== JSON.stringify(document.notify))
          failure('The Codex notify entry is ambiguous')
      } catch { failure('The Codex notify entry is ambiguous') }
      match = {
        start: offset,
        valueStart: offset + prefix.length,
        valueEnd: offset + prefix.length + value.length,
        lineEnd: offset + line.length
      }
    }
    offset += line.length
  }
  if ((document.notify === undefined) !== (match === undefined))
    failure('The Codex notify entry is ambiguous')
  return match
}

function insertCodexNotify(text: string, value: string): { text: string; inserted: string } {
  let offset = 0
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    if (/^[ \t]*\[/u.test(line)) break
    offset += line.length
  }
  const before = text.slice(0, offset)
  const inserted = `${before && !before.endsWith('\n') ? '\n' : ''}notify = ${value}\n`
  return { text: before + inserted + text.slice(offset), inserted }
}

async function managedCommand(): Promise<{ codex: string[]; claude: Record<string, unknown> }> {
  const executable = await realpath(process.execPath)
  const script = process.argv[1]
  if (!script || !isAbsolute(script)) failure('The CLI entrypoint must be absolute')
  const cli = await realpath(script)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return {
    codex: [executable, cli, 'hook', 'codex'],
    claude: {
      matcher: '',
      hooks: [{ type: 'command', command: `${quote(executable)} ${quote(cli)} hook claude` }]
    }
  }
}

function claudeEntries(document: Record<string, unknown>, create: boolean): unknown[] | undefined {
  let hooks = document.hooks
  if (hooks === undefined && create) hooks = document.hooks = {}
  if (hooks === undefined) return
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
    failure('The Claude hooks configuration is malformed')
  const record = hooks as Record<string, unknown>
  let entries = record.Notification
  if (entries === undefined && create) entries = record.Notification = []
  if (entries === undefined) return
  if (!Array.isArray(entries)) failure('The Claude Notification hooks are malformed')
  return entries as unknown[]
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }

function validateState(value: unknown, agent: Agent, configPath: string): State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('Secure hook state is invalid')
  const state = value as Partial<State>
  if (state.version !== 1 || state.integration !== agent || state.configPath !== configPath ||
      typeof state.configExisted !== 'boolean') failure('Secure hook state is invalid')
  if (agent === 'codex') {
    if (!Array.isArray(state.managed) || state.managed.length !== 4 ||
        state.managed[2] !== 'hook' || state.managed[3] !== 'codex' ||
        !state.managed.slice(0, 2).every((part) => typeof part === 'string' && isAbsolute(part)))
      failure('Secure hook state is invalid')
  } else if (typeof state.claudeManagedIndex !== 'number' ||
             typeof state.priorClaudeManagedCount !== 'number' ||
             !Number.isSafeInteger(state.claudeManagedIndex) || state.claudeManagedIndex < 0 ||
             !Number.isSafeInteger(state.priorClaudeManagedCount) || state.priorClaudeManagedCount < 0 ||
             !state.managed || typeof state.managed !== 'object' ||
             !Array.isArray((state.managed as Record<string, unknown>).hooks) ||
             (state.managed as { hooks: unknown[] }).hooks.length !== 1) {
    failure('Secure hook state is invalid')
  }
  return state as State
}

async function stateAt(path: string, agent: Agent, config: string): Promise<State | undefined> {
  const { existed, text } = await readOptional(path, true)
  if (!existed) return
  try { return validateState(JSON.parse(text), agent, config) }
  catch { return failure('Secure hook state is invalid') }
}

function matches(agent: Agent, document: Record<string, unknown>, state: State): boolean {
  if (agent === 'codex') return same(document.notify, state.managed)
  const entries = claudeEntries(document, false)
  if (!entries) return false
  const count = entries.filter((item) => same(item, state.managed)).length
  return count === state.priorClaudeManagedCount! + 1 &&
    same(entries[state.claudeManagedIndex!], state.managed)
}

export async function hookStatus(agent: Agent, home?: string): Promise<Status> {
  const at = paths(agent, home)
  const state = await stateAt(at.state, agent, at.config)
  if (!state) return 'not installed'
  const { text } = await readOptional(at.config)
  const document = agent === 'codex' ? parseCodex(text) : parseClaude(text)
  return matches(agent, document, state) ? 'installed' : 'conflict'
}

export async function hookInstall(agent: Agent, home?: string): Promise<void> {
  const at = paths(agent, home)
  const config = await readOptional(at.config)
  const existing = await stateAt(at.state, agent, at.config)
  const managed = (await managedCommand())[agent]
  if (existing) {
    const document = agent === 'codex' ? parseCodex(config.text) : parseClaude(config.text)
    if (same(existing.managed, managed) && matches(agent, document, existing)) return
    failure('The managed hook conflicts with edits made after installation')
  }
  if ((await readOptional(at.backup, true)).existed) {
    failure('A stale hook backup exists without managed state; refusing to overwrite it')
  }
  let output: string
  let state: State
  if (agent === 'codex') {
    const document = parseCodex(config.text)
    const span = rootNotifySpan(config.text, document)
    const encoded = JSON.stringify(managed)
    const priorCodexValue = span ? config.text.slice(span.valueStart, span.valueEnd) : undefined
    const inserted = span ? undefined : insertCodexNotify(config.text, encoded)
    output = span
      ? config.text.slice(0, span.valueStart) + encoded + config.text.slice(span.valueEnd)
      : inserted!.text
    if (!same(parseCodex(output).notify, managed)) failure('The Codex edit could not be validated')
    state = {
      version: 1, integration: agent, configPath: at.config, configExisted: config.existed,
      managed, ...(priorCodexValue !== undefined ? { priorCodexValue } : {}),
      ...(inserted ? { insertedCodexText: inserted.inserted } : {})
    }
  } else {
    const document = parseClaude(config.text)
    const priorClaudeNotificationExisted = claudeEntries(document, false) !== undefined
    const entries = claudeEntries(document, true)!
    const priorClaudeManagedCount = entries.filter((item) => same(item, managed)).length
    const claudeManagedIndex = entries.length
    output = priorClaudeNotificationExisted
      ? appendClaudeEntry(config.text, managed)
      : editClaude(config.text, ['hooks', 'Notification'], [managed])
    if (!same(claudeEntries(parseClaude(output), false)?.[claudeManagedIndex], managed))
      failure('The Claude edit could not be validated')
    state = {
      version: 1, integration: agent, configPath: at.config, configExisted: config.existed,
      managed, priorClaudeNotificationExisted, claudeManagedIndex, priorClaudeManagedCount
    }
  }
  await writeBackup(at.backup, config.text)
  await writeAtomic(at.state, `${JSON.stringify(state)}\n`)
  try { await writeAtomic(at.config, output) }
  catch (error) { await rm(at.state, { force: true }); throw error }
}

export async function hookUninstall(agent: Agent, home?: string): Promise<void> {
  const at = paths(agent, home)
  const state = await stateAt(at.state, agent, at.config)
  if (!state) failure('The hook is not installed')
  const config = await readOptional(at.config)
  let output: string
  if (agent === 'codex') {
    const document = parseCodex(config.text)
    if (!matches(agent, document, state)) failure('The managed hook conflicts with edits made after installation')
    const span = rootNotifySpan(config.text, document)
    if (!span) failure('The managed hook is missing')
    if (state.priorCodexValue !== undefined) {
      output = config.text.slice(0, span.valueStart) + state.priorCodexValue + config.text.slice(span.valueEnd)
    } else {
      const inserted = state.insertedCodexText
      const index = inserted ? config.text.indexOf(inserted) : -1
      if (index !== span.start - (inserted?.startsWith('\n') ? 1 : 0) ||
          index + inserted!.length < span.lineEnd)
        failure('The managed hook conflicts with edits made after installation')
      output = config.text.slice(0, index) + config.text.slice(index + inserted!.length)
    }
    const restored = parseCodex(output)
    if (state.priorCodexValue === undefined ? restored.notify !== undefined :
      JSON.stringify(restored.notify) === JSON.stringify(state.managed))
      failure('The restored Codex configuration is invalid')
  } else {
    const document = parseClaude(config.text)
    if (!matches(agent, document, state)) failure('The managed hook conflicts with edits made after installation')
    const entries = claudeEntries(document, false)!
    entries.splice(state.claudeManagedIndex!, 1)
    if (!state.priorClaudeNotificationExisted && entries.length === 0) {
      output = editClaude(config.text, ['hooks', 'Notification'], undefined)
      const remainingHooks = parseClaude(output).hooks
      if (remainingHooks === undefined ||
          (remainingHooks !== null && typeof remainingHooks === 'object' &&
           Object.keys(remainingHooks).length === 0))
        output = editClaude(output, ['hooks'], undefined)
    } else {
      output = removeClaudeEntry(config.text, state.claudeManagedIndex!)
    }
  }
  if (!state.configExisted && (agent === 'codex' ? output.trim() === '' :
    Object.keys(parseClaude(output)).length === 0)) {
    await rm(at.config, { force: true })
  } else {
    await writeAtomic(at.config, output)
  }
  await rm(at.state)
  await rm(at.backup)
}

export function integration(value: string): Agent {
  if (value === 'codex' || value === 'claude') return value
  return failure('Expected codex or claude')
}
