import { expect, it } from 'vitest'

import { RemoteTargetOperationLock } from './remote-target-operation-lock'

const TARGET_A = '00000000-0000-4000-8000-0000000000a1'
const TARGET_B = '00000000-0000-4000-8000-0000000000b2'

it('serializes one target through rejection while another target proceeds', async () => {
  const lock = new RemoteTargetOperationLock()
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const first = lock.withTarget(TARGET_A, async () => {
    events.push('first entered')
    await gate
    events.push('first leaving')
    throw new Error('failed operation')
  })
  const second = lock.withTarget(TARGET_A, () => {
    events.push('second entered')
    return Promise.resolve()
  })
  const other = lock.withTarget(TARGET_B, () => {
    events.push('other entered')
    return Promise.resolve()
  })
  await other
  expect(events).toEqual(['first entered', 'other entered'])
  release()
  await expect(first).rejects.toThrow('failed operation')
  await second
  expect(events).toEqual(['first entered', 'other entered', 'first leaving', 'second entered'])
})
