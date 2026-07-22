import type {
  WorkspaceCardSlotV2Kind,
  WorkspaceCardSlotV2Payload,
  WorkspaceCardSlotV2Snapshot
} from '@agent-workspace/protocol-client'
import { isSafeExternalUrl } from '@agent-workspace/protocol-client'
import type { JSX, ReactNode } from 'react'

import { messages } from '../messages'

export type WorkspaceCardSlotsV2 = Partial<
  Record<WorkspaceCardSlotV2Kind, WorkspaceCardSlotV2Snapshot>
>

const ORDER: readonly WorkspaceCardSlotV2Kind[] = [
  'agentStatus',
  'progress',
  'pullRequest',
  'metadata',
  'markdown',
  'logTail',
  'task',
  'ssh',
  'media'
]

export function WorkspaceCardSlotsV2({
  slots
}: {
  slots: WorkspaceCardSlotsV2 | undefined
}): JSX.Element | null {
  const payloads = ORDER.flatMap((kind) => {
    const payload = slots?.[kind]?.payload
    return payload && payload.kind === kind ? [payload] : []
  })
  if (payloads.length === 0) return null
  return (
    <section aria-label={messages.workspaceCardSlotsV2.summary} className="workspace-card-slots-v2">
      {payloads.map((payload) => (
        <CardSlot key={payload.kind} payload={payload} />
      ))}
    </section>
  )
}

function CardSlot({ payload }: { payload: WorkspaceCardSlotV2Payload }): JSX.Element {
  switch (payload.kind) {
    case 'agentStatus':
      return (
        <small aria-atomic="true" aria-live="polite" className="workspace-card-v2-row">
          <SlotLabel kind={payload.kind} />
          {messages.workspaceCardSlots.agentStatus[payload.value.status]}
          {payload.value.label ? ` — ${payload.value.label}` : ''}
        </small>
      )
    case 'progress': {
      const progress = payload.value
      const accessible =
        progress.mode === 'determinate'
          ? messages.workspaceCardSlots.progressAccessible(progress.value, progress.label)
          : messages.workspaceCardSlots.indeterminateAccessible(progress.label)
      return (
        <div
          aria-label={accessible}
          aria-valuemax={progress.mode === 'determinate' ? 100 : undefined}
          aria-valuemin={progress.mode === 'determinate' ? 0 : undefined}
          aria-valuenow={progress.mode === 'determinate' ? progress.value : undefined}
          aria-valuetext={accessible}
          className="workspace-card-v2-progress"
          role="progressbar"
        >
          <span>
            <SlotLabel kind={payload.kind} />
            {progress.label ? `${progress.label} · ` : ''}
            {progress.mode === 'determinate'
              ? `${String(progress.value)}%`
              : messages.workspaceCardSlots.inProgress}
          </span>
          {progress.mode === 'determinate' ? (
            <span aria-hidden="true" className="workspace-card-progress-track">
              <span style={{ width: `${String(progress.value)}%` }} />
            </span>
          ) : null}
        </div>
      )
    }
    case 'pullRequest': {
      const value = payload.value
      const safeUrl =
        value.url?.startsWith('https://') && isSafeExternalUrl(value.url) ? value.url : undefined
      const content = (
        <>
          <SlotLabel kind={payload.kind} />
          {value.provider} #{String(value.number)} · {value.title} · {value.lifecycle} ·{' '}
          {value.checks}
        </>
      )
      return safeUrl ? (
        <a
          className="workspace-card-v2-row workspace-card-v2-link"
          href={safeUrl}
          onClick={(event) => {
            event.preventDefault()
            void window.desktopBridge.openExternal(safeUrl)
          }}
          rel="noreferrer noopener"
        >
          {content}
        </a>
      ) : (
        <small className="workspace-card-v2-row">{content}</small>
      )
    }
    case 'metadata':
      return (
        <dl
          aria-label={messages.workspaceCardSlotsV2.names.metadata}
          className="workspace-card-v2-metadata"
        >
          {payload.value.rows.map((row) => (
            <div key={row.key.toLocaleLowerCase('und')}>
              <dt>{row.key}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'markdown':
      return (
        <div
          aria-label={messages.workspaceCardSlotsV2.names.markdown}
          className="workspace-card-v2-markdown"
        >
          <SafeMarkdown source={payload.value.source} />
        </div>
      )
    case 'logTail':
      return (
        <div
          aria-label={messages.workspaceCardSlotsV2.names.logTail}
          className="workspace-card-v2-log"
          role="region"
          tabIndex={0}
        >
          {payload.value.lines.map((line, index) => (
            <code key={`${String(index)}:${line}`}>{line}</code>
          ))}
          {payload.value.truncated ? (
            <small>{messages.workspaceCardSlotsV2.truncated}</small>
          ) : null}
        </div>
      )
    case 'task':
      return (
        <div
          aria-label={messages.workspaceCardSlotsV2.names.task}
          className="workspace-card-v2-task"
        >
          <strong>{payload.value.title}</strong>
          <ul>
            {payload.value.items.map((item) => (
              <li key={item.id}>
                <span aria-hidden="true">{item.state === 'completed' ? '✓' : '○'}</span>{' '}
                {item.label} <small>({item.state})</small>
              </li>
            ))}
          </ul>
        </div>
      )
    case 'ssh':
      return (
        <small className="workspace-card-v2-row">
          <SlotLabel kind={payload.kind} />
          {payload.value.label} · {payload.value.state}
        </small>
      )
    case 'media':
      return (
        <small className="workspace-card-v2-row">
          <SlotLabel kind={payload.kind} />
          {payload.value.label} · {payload.value.mediaKind} · {payload.value.state}
        </small>
      )
  }
}

function SlotLabel({ kind }: { kind: WorkspaceCardSlotV2Kind }): JSX.Element {
  return (
    <span className="workspace-card-slot-label">{messages.workspaceCardSlotsV2.names[kind]}: </span>
  )
}

function SafeMarkdown({ source }: { source: string }): JSX.Element {
  const withoutImages = source.replaceAll(/!\[[^\]]*\]\([^\n)]*\)/gu, '')
  const blocks = withoutImages.split(/\n{2,}/u)
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${String(index)}:${block.slice(0, 16)}`
        const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(block)
        if (fence)
          return (
            <pre key={key}>
              <code>{fence[1]}</code>
            </pre>
          )
        const heading = /^(#{1,6})\s+(.+)$/u.exec(block)
        if (heading) {
          const Heading = `h${String(Math.min(6, heading[1]!.length + 2))}` as 'h3'
          return <Heading key={key}>{inlineMarkdown(heading[2]!)}</Heading>
        }
        const lines = block.split('\n')
        if (lines.every((line) => /^[-*+]\s+/u.test(line))) {
          return (
            <ul key={key}>
              {lines.map((line) => (
                <li key={line}>{inlineMarkdown(line.replace(/^[-*+]\s+/u, ''))}</li>
              ))}
            </ul>
          )
        }
        if (lines.every((line) => /^\d+\.\s+/u.test(line))) {
          return (
            <ol key={key}>
              {lines.map((line) => (
                <li key={line}>{inlineMarkdown(line.replace(/^\d+\.\s+/u, ''))}</li>
              ))}
            </ol>
          )
        }
        return <p key={key}>{inlineMarkdown(block)}</p>
      })}
    </>
  )
}

function inlineMarkdown(value: string): ReactNode[] {
  const parts: ReactNode[] = []
  const pattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^\n)]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/gu
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const offset = match.index
    if (offset > cursor) parts.push(value.slice(cursor, offset))
    const token = match[0]
    const key = `${String(offset)}:${token}`
    if (token.startsWith('`')) parts.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('*')) parts.push(<em key={key}>{token.slice(1, -1)}</em>)
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token)
      const url = link?.[2]
      const safe = isSafeMarkdownUrl(url)
      parts.push(
        safe ? (
          <a
            href={url}
            key={key}
            onClick={(event) => {
              event.preventDefault()
              void window.desktopBridge.openExternal(url!)
            }}
            rel="noreferrer noopener"
          >
            {link![1]}
          </a>
        ) : (
          (link?.[1] ?? token)
        )
      )
    }
    cursor = offset + token.length
  }
  if (cursor < value.length) parts.push(value.slice(cursor))
  return parts
}

function isSafeMarkdownUrl(url: string | undefined): boolean {
  return url !== undefined && isSafeExternalUrl(url)
}
