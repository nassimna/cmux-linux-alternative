import { resolveCommandAvailability, type CommandContext, type CommandDefinition } from './types'

export type PaletteMatchedField = 'title' | 'alias' | 'category' | 'id' | 'recent'

export interface PaletteMatch {
  readonly command: CommandDefinition
  readonly score: number
  readonly matchedField: PaletteMatchedField
  readonly available: boolean
  readonly unavailableReason?: string
}

interface TextScore {
  readonly score: number
  readonly matchedField: Exclude<PaletteMatchedField, 'recent'>
}

function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function subsequenceScore(candidate: string, query: string): number | undefined {
  let queryIndex = 0
  let firstIndex = -1
  let previousIndex = -1
  let gaps = 0

  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue
    if (firstIndex === -1) firstIndex = index
    if (previousIndex !== -1) gaps += index - previousIndex - 1
    previousIndex = index
    queryIndex += 1
  }

  if (queryIndex !== query.length) return undefined
  return 60 + firstIndex + gaps + Math.max(0, candidate.length - query.length) / 100
}

function fieldScore(candidateValue: string, query: string): number | undefined {
  const candidate = normalizeSearchText(candidateValue)
  if (candidate === query) return 0
  if (candidate.startsWith(query)) return 10 + (candidate.length - query.length) / 100
  const wordIndex = candidate.indexOf(` ${query}`)
  if (wordIndex !== -1) return 20 + wordIndex / 100
  const substringIndex = candidate.indexOf(query)
  if (substringIndex !== -1) return 30 + substringIndex / 100
  return subsequenceScore(candidate, query)
}

function scoreCommand(command: CommandDefinition, query: string): TextScore | undefined {
  const candidates: readonly (readonly [string, TextScore['matchedField'], number])[] = [
    [command.title, 'title', 0],
    ...(command.aliases ?? []).map((alias) => [alias, 'alias', 8] as const),
    [command.category, 'category', 16],
    [command.id, 'id', 24]
  ]

  let best: TextScore | undefined
  for (const [value, matchedField, fieldPenalty] of candidates) {
    const score = fieldScore(value, query)
    if (score === undefined) continue
    const result = { score: score + fieldPenalty, matchedField }
    if (best === undefined || result.score < best.score) best = result
  }
  return best
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function searchCommands(
  commands: readonly CommandDefinition[],
  query: string,
  recentCommandIds: readonly string[],
  context: CommandContext
): readonly PaletteMatch[] {
  const normalizedQuery = normalizeSearchText(query)
  const recency = new Map<string, number>()
  for (const commandId of recentCommandIds) {
    if (!recency.has(commandId)) recency.set(commandId, recency.size)
  }

  const matches = commands.flatMap((command, registryIndex) => {
    const textScore =
      normalizedQuery.length === 0
        ? { score: 0, matchedField: 'recent' as const }
        : scoreCommand(command, normalizedQuery)
    if (textScore === undefined) return []

    const availability = resolveCommandAvailability(command, context)
    return [
      {
        command,
        score: textScore.score,
        matchedField: textScore.matchedField,
        available: availability.available,
        ...(availability.reason === undefined ? {} : { unavailableReason: availability.reason }),
        registryIndex,
        recentIndex: recency.get(command.id) ?? Number.POSITIVE_INFINITY
      }
    ]
  })

  return matches
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score
      if (left.recentIndex !== right.recentIndex) return left.recentIndex - right.recentIndex
      if (left.registryIndex !== right.registryIndex)
        return left.registryIndex - right.registryIndex
      return lexicalCompare(left.command.id, right.command.id)
    })
    .map((match) => ({
      command: match.command,
      score: match.score,
      matchedField: match.matchedField,
      available: match.available,
      ...(match.unavailableReason === undefined
        ? {}
        : { unavailableReason: match.unavailableReason })
    }))
}
