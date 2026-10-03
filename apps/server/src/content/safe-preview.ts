import type { SafeMarkdownNode } from '@agent-workspace/protocol-client'

function takeCharacters(value: string, count: number): string {
  let result = ''
  let characters = 0
  for (const character of value) {
    if (characters >= count || result.length + character.length > count) break
    result += character
    characters++
  }
  return result
}

// Rust str::lines removes the final empty row and the CR in CRLF.
export function previewLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function inlineNodes(value: string): SafeMarkdownNode[] {
  const bounded = takeCharacters(value, 16_384)
  if (!bounded.includes('<') && !bounded.includes('>')) {
    const a = bounded.indexOf('[')
    const b = bounded.indexOf('](')
    const c = bounded.lastIndexOf(')')
    const d = bounded.indexOf('http')
    if (a >= 0 && b > a && c > b && d === b + 2) {
      const href = bounded.slice(d, c)
      const label = bounded.slice(a + 1, b)
      try {
        const parsed = new URL(href)
        if (
          (href.startsWith('http://') || href.startsWith('https://')) &&
          !parsed.username &&
          !parsed.password &&
          href.length <= 2048 &&
          label.length <= 2048
        )
          return [{ kind: 'link', label, href }]
      } catch {
        // An unsafe or invalid link remains literal text.
      }
    }
  }
  return [{ kind: 'text', text: bounded }]
}

/** The same deliberately small, bounded Markdown grammar as workspace-content. */
export function parseSafeMarkdown(source: string): SafeMarkdownNode[] {
  const nodes: SafeMarkdownNode[] = []
  const lines = previewLines(source)
  for (let index = 0; index < lines.length && nodes.length < 4096; index++) {
    const line = lines[index]!
    if (line.startsWith('```')) {
      const language = line.slice(3).trim()
      const rows: string[] = []
      while (++index < lines.length && lines[index] !== '```') {
        rows.push(takeCharacters(lines[index]!, 16_384))
      }
      nodes.push({
        kind: 'codeBlock',
        language: language ? takeCharacters(language, 32) : null,
        text: takeCharacters(rows.join('\n'), 65_536)
      })
      continue
    }
    const hashes = /^#{1,6} /u.exec(line)?.[0].length
    if (hashes) {
      nodes.push({ kind: 'heading', level: hashes - 1, children: inlineNodes(line.slice(hashes)) })
    } else if (line.startsWith('- ')) {
      nodes.push({
        kind: 'list',
        ordered: false,
        items: [{ kind: 'listItem', children: inlineNodes(line.slice(2)) }]
      })
    } else if (line.trim()) {
      nodes.push({ kind: 'paragraph', children: inlineNodes(line) })
    }
  }
  return nodes
}

export function boundedDiff(before: string, after: string) {
  const beforeLines = previewLines(before)
  const afterLines = previewLines(after)
  const beforeSet = new Set(beforeLines)
  const afterSet = new Set(afterLines)
  const lines: Array<{ kind: 'removed' | 'context' | 'added'; text: string }> = []
  for (const line of beforeLines.slice(0, 2048)) {
    if (!afterSet.has(line)) lines.push({ kind: 'removed', text: takeCharacters(line, 16_384) })
  }
  for (const line of afterLines.slice(0, 2048)) {
    lines.push({
      kind: beforeSet.has(line) ? 'context' : 'added',
      text: takeCharacters(line, 16_384)
    })
  }
  return { lines, truncated: lines.length >= 4096 }
}
