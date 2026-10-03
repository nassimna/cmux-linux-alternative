// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import {
  runAfterNotificationCenterClose,
  waitForNotificationCenterClose
} from './notification-center-close'

describe('notification center close gate', () => {
  it('reports success after the notification center unmounts', async () => {
    document.body.innerHTML = '<div data-notification-center="true"></div>'
    const nextFrame = vi.fn(() => {
      document.querySelector('[data-notification-center="true"]')?.remove()
      return Promise.resolve()
    })

    await expect(
      waitForNotificationCenterClose({ attempts: 1, nextFrame, root: document })
    ).resolves.toEqual({ ok: true })
    expect(nextFrame).toHaveBeenCalledOnce()
  })

  it('returns a timeout and does not run navigation while the center remains mounted', async () => {
    document.body.innerHTML = '<div data-notification-center="true"></div>'
    const jump = vi.fn(() => Promise.resolve({ ok: true as const }))
    const onFailure = vi.fn()
    const waitForClose = () =>
      waitForNotificationCenterClose({
        attempts: 2,
        nextFrame: () => Promise.resolve(),
        root: document
      })

    await expect(runAfterNotificationCenterClose(jump, onFailure, waitForClose)).resolves.toEqual({
      ok: false,
      message: 'The notification center did not close. Try opening the target again.'
    })
    expect(jump).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith({
      ok: false,
      message: 'The notification center did not close. Try opening the target again.'
    })
  })
})
