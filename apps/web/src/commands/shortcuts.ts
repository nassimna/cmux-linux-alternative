import type { CommandDefinition, CommandId } from './types'
import { messages } from '../messages'

export type LogicalModifier = 'Primary' | 'Secondary' | 'Shift' | 'Control'
export type ShortcutPlatform = 'macos' | 'other'

export interface Shortcut {
  readonly modifiers: readonly LogicalModifier[]
  readonly key: string
}

export type ShortcutOverride = Shortcut | null
export type ShortcutOverrides = Partial<Record<CommandId, ShortcutOverride>>
export type SerializedShortcutOverrides = Partial<Record<CommandId, string | null>>

export interface KeyboardEventLike {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly isComposing?: boolean
  readonly repeat?: boolean
  preventDefault?: () => void
}

export interface ShortcutConflict {
  readonly shortcut: Shortcut
  readonly commandIds: readonly CommandId[]
}

export type ShortcutValidationResult =
  | { readonly valid: true; readonly shortcut: Shortcut }
  | { readonly valid: false; readonly reason: string }

const MODIFIER_ORDER: readonly LogicalModifier[] = ['Primary', 'Secondary', 'Control', 'Shift']
const MODIFIER_LOOKUP: Readonly<Record<string, LogicalModifier>> = {
  primary: 'Primary',
  secondary: 'Secondary',
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control'
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  spacebar: 'Space',
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote'
}

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down'
}

const NAMED_KEYS = new Set([
  'Backspace',
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  ...Object.keys(DISPLAY_KEYS)
])

export function normalizeShortcutKey(key: string): string | undefined {
  if (key.length === 0) return undefined

  const alias = KEY_ALIASES[key.toLowerCase()]
  if (alias !== undefined) return alias
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key)) return key
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()

  const named = [...NAMED_KEYS].find((candidate) => candidate.toLowerCase() === key.toLowerCase())
  return named
}

export function normalizeShortcut(shortcut: Shortcut): ShortcutValidationResult {
  const key = normalizeShortcutKey(shortcut.key)
  if (key === undefined) {
    return { valid: false, reason: messages.shortcutValidation.unsupportedNonModifierKey }
  }

  const seen = new Set<LogicalModifier>()
  for (const modifier of shortcut.modifiers) {
    if (!MODIFIER_ORDER.includes(modifier)) {
      return {
        valid: false,
        reason: messages.shortcutValidation.unknownLogicalModifier(String(modifier))
      }
    }
    if (seen.has(modifier)) {
      return {
        valid: false,
        reason: messages.shortcutValidation.duplicateLogicalModifier(modifier)
      }
    }
    seen.add(modifier)
  }

  return {
    valid: true,
    shortcut: {
      modifiers: MODIFIER_ORDER.filter((modifier) => seen.has(modifier)),
      key
    }
  }
}

export function parseShortcut(value: string): ShortcutValidationResult {
  const parts = value.split('+').map((part) => part.trim())
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    return { valid: false, reason: messages.shortcutValidation.emptyKeyOrModifier }
  }

  const modifiers: LogicalModifier[] = []
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_LOOKUP[part.toLowerCase()]
    if (modifier === undefined) {
      return {
        valid: false,
        reason: messages.shortcutValidation.unknownLogicalModifier(part)
      }
    }
    modifiers.push(modifier)
  }

  const last = parts.at(-1)
  const lastAsModifier = last === undefined ? undefined : MODIFIER_LOOKUP[last.toLowerCase()]
  if (lastAsModifier !== undefined) {
    return { valid: false, reason: messages.shortcutValidation.missingNonModifierKey }
  }

  return normalizeShortcut({ modifiers, key: last ?? '' })
}

export function serializeShortcut(shortcut: Shortcut): string {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized.valid) throw new Error(normalized.reason)
  return [...normalized.shortcut.modifiers, normalized.shortcut.key].join('+')
}

export function formatShortcut(shortcut: Shortcut, platform: ShortcutPlatform): string {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized.valid) throw new Error(normalized.reason)

  const key = DISPLAY_KEYS[normalized.shortcut.key] ?? normalized.shortcut.key
  if (platform === 'macos') {
    const symbols: Readonly<Record<LogicalModifier, string>> = {
      Primary: '⌘',
      Secondary: '⌥',
      Control: '⌃',
      Shift: '⇧'
    }
    return `${normalized.shortcut.modifiers.map((modifier) => symbols[modifier]).join('')}${key}`
  }

  const names: Readonly<Record<LogicalModifier, string>> = {
    Primary: 'Ctrl',
    Secondary: 'Alt',
    Control: 'Ctrl',
    Shift: 'Shift'
  }
  return [...normalized.shortcut.modifiers.map((modifier) => names[modifier]), key].join('+')
}

export function shortcutMatchesEvent(
  shortcut: Shortcut,
  event: KeyboardEventLike,
  platform: ShortcutPlatform
): boolean {
  const normalized = normalizeShortcut(shortcut)
  const eventKey = normalizeShortcutKey(event.key)
  if (!normalized.valid || eventKey === undefined || eventKey !== normalized.shortcut.key)
    return false

  const modifiers = new Set(normalized.shortcut.modifiers)
  const expectedMeta = platform === 'macos' && modifiers.has('Primary')
  const expectedControl =
    modifiers.has('Control') || (platform === 'other' && modifiers.has('Primary'))
  const expectedAlt = modifiers.has('Secondary')
  const expectedShift = modifiers.has('Shift')

  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedControl &&
    event.altKey === expectedAlt &&
    event.shiftKey === expectedShift
  )
}

export function effectiveShortcut(
  command: CommandDefinition,
  overrides: ShortcutOverrides
): Shortcut | undefined {
  if (Object.prototype.hasOwnProperty.call(overrides, command.id)) {
    return overrides[command.id] ?? undefined
  }
  return command.defaultShortcut
}

export function shortcutPhysicalIdentity(shortcut: Shortcut, platform: ShortcutPlatform): string {
  const modifiers = new Set(shortcut.modifiers)
  const physicalModifiers = [
    platform === 'macos' && modifiers.has('Primary') ? 'Meta' : undefined,
    modifiers.has('Control') || (platform === 'other' && modifiers.has('Primary'))
      ? 'Control'
      : undefined,
    modifiers.has('Secondary') ? 'Alt' : undefined,
    modifiers.has('Shift') ? 'Shift' : undefined
  ].filter((modifier): modifier is string => modifier !== undefined)

  return [...physicalModifiers, shortcut.key].join('+')
}

export function findShortcutConflicts(
  commands: readonly CommandDefinition[],
  overrides: ShortcutOverrides,
  platform: ShortcutPlatform = 'other'
): readonly ShortcutConflict[] {
  const byShortcut = new Map<string, { shortcut: Shortcut; commandIds: CommandId[] }>()

  for (const command of commands) {
    const shortcut = effectiveShortcut(command, overrides)
    if (shortcut === undefined) continue
    const normalized = normalizeShortcut(shortcut)
    if (!normalized.valid) continue
    const physicalIdentity = shortcutPhysicalIdentity(normalized.shortcut, platform)
    const existing = byShortcut.get(physicalIdentity)
    if (existing === undefined) {
      byShortcut.set(physicalIdentity, {
        shortcut: normalized.shortcut,
        commandIds: [command.id]
      })
    } else {
      existing.commandIds.push(command.id)
    }
  }

  return [...byShortcut.entries()]
    .filter(([, conflict]) => conflict.commandIds.length > 1)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, conflict]) => conflict)
}

export function serializeShortcutOverrides(
  overrides: ShortcutOverrides
): SerializedShortcutOverrides {
  const serialized: SerializedShortcutOverrides = {}
  for (const commandId of Object.keys(overrides).sort() as CommandId[]) {
    const shortcut = overrides[commandId]
    if (shortcut === undefined) continue
    serialized[commandId] = shortcut === null ? null : serializeShortcut(shortcut)
  }
  return serialized
}

export function deserializeShortcutOverrides(serialized: SerializedShortcutOverrides): {
  readonly overrides: ShortcutOverrides
  readonly errors: Readonly<Partial<Record<CommandId, string>>>
} {
  const overrides: ShortcutOverrides = {}
  const errors: Partial<Record<CommandId, string>> = {}

  for (const commandId of Object.keys(serialized).sort() as CommandId[]) {
    const value = serialized[commandId]
    if (value === null) {
      overrides[commandId] = null
      continue
    }
    if (value === undefined) continue
    const parsed = parseShortcut(value)
    if (parsed.valid) overrides[commandId] = parsed.shortcut
    else errors[commandId] = parsed.reason
  }

  return { overrides, errors }
}
