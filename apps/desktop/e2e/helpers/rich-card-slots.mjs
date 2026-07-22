export async function seedRepresentativeRichCardSlots(page, workspaceId) {
  const payloads = [
    { kind: 'agentStatus', value: { status: 'running', label: 'Reviewing safely' } },
    { kind: 'progress', value: { mode: 'determinate', value: 73, label: 'Qualification' } },
    {
      kind: 'pullRequest',
      value: {
        provider: 'GitHub',
        number: 42,
        title: 'Bounded rich cards',
        lifecycle: 'open',
        checks: 'passing',
        url: 'https://example.com/pull/42'
      }
    },
    {
      kind: 'metadata',
      value: { rows: [{ key: 'Owner', value: 'Desktop qualification' }] }
    },
    {
      kind: 'markdown',
      value: {
        source:
          '# Safe notes\n\n<script>globalThis.compromised=true</script> ![remote](https://evil.invalid/pixel.png)\n\n[Approved link](https://example.com/docs) [Blocked link](javascript:alert(1))'
      }
    },
    {
      kind: 'logTail',
      value: { lines: ['static log line one', 'static log line two'], truncated: true }
    },
    {
      kind: 'task',
      value: {
        title: 'Release checklist',
        items: [
          {
            id: '20000000-0000-4000-8000-000000000001',
            label: 'Audit semantics',
            state: 'completed'
          },
          {
            id: '20000000-0000-4000-8000-000000000002',
            label: 'Capture baseline',
            state: 'inProgress'
          }
        ]
      }
    },
    { kind: 'ssh', value: { label: 'Public build host', state: 'connected' } },
    {
      kind: 'media',
      value: { mediaKind: 'audio', state: 'playing', label: 'Build notification' }
    }
  ]
  await page.evaluate(
    async ({ payloads: seededPayloads, workspaceId: id }) => {
      for (const payload of seededPayloads) {
        await globalThis.desktopBridge.replaceWorkspaceCardSlotV2({
          workspaceId: id,
          kind: payload.kind,
          expectedRevision: 0,
          payload
        })
      }
    },
    { payloads, workspaceId }
  )
}
