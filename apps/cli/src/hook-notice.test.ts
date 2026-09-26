import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseClaudeNotice, parseCodexNotice, readClaudeHookInput } from './hook-notice'

test('Codex hook keeps only bounded notification fields', () => {
  const notice = parseCodexNotice(
    JSON.stringify({
      type: ' agent-turn-complete\n',
      'last-assistant-message': ' done\twith\ncontrol ',
      'input-messages': ['private prompt']
    })
  )
  assert.deepEqual(notice, { title: 'agent-turn-complete', body: 'donewithcontrol' })
  assert.deepEqual(parseCodexNotice('{"last_assistant_message":"ok"}'), {
    title: 'Codex',
    body: 'ok'
  })
})

test('Claude hook accepts bounded stdin and does not forward transcript fields', async () => {
  const input = async function* () {
    yield Buffer.from('{"notification_type":"permission_prompt",')
    yield Buffer.from('"message":"approve","transcript_path":"/private"}')
  }
  assert.deepEqual(parseClaudeNotice(await readClaudeHookInput(input())), {
    title: 'permission_prompt',
    body: 'approve'
  })
})

test('hook payloads reject malformed or oversized input', async () => {
  assert.throws(() => parseCodexNotice('{'))
  assert.throws(() => parseCodexNotice('x'.repeat(64 * 1024 + 1)))
  const input = async function* () {
    yield Buffer.alloc(64 * 1024)
    yield Buffer.from('x')
  }
  await assert.rejects(() => readClaudeHookInput(input()))
})
