import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { assertDisposableLivePreview } from './live-preview-policy'

it('allows only explicitly enabled temporary live fixtures', () => {
  const fixture = join(tmpdir(), 'agent-workspace-live-smoke-123', 'profile', 'state.sqlite3')
  expect(() => assertDisposableLivePreview(fixture, true)).not.toThrow()
  expect(() => assertDisposableLivePreview(fixture, false)).toThrow()
  expect(() => assertDisposableLivePreview('/home/user/state/workspace.sqlite', true)).toThrow()
  expect(() =>
    assertDisposableLivePreview(join(tmpdir(), 'other-project', 'state.sqlite3'), true)
  ).toThrow()
})
