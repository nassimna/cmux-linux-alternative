// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LegacyOverLimitSnapshot } from '@agent-workspace/protocol-client'

import { LegacyOverLimitNotice, legacyOverLimitCounts } from './LegacyOverLimitNotice'

afterEach(cleanup)

const legacy = {
  workspaceCount: 130,
  maximumPanesInWorkspace: 65,
  maximumTabsInWorkspace: 129,
  totalPaneCount: 1025,
  totalTabCount: 2049,
  exceededDimensions: [
    'workspaces',
    'panesPerWorkspace',
    'tabsPerWorkspace',
    'totalPanes',
    'totalTabs'
  ]
} satisfies LegacyOverLimitSnapshot

describe('LegacyOverLimitNotice', () => {
  it('reports every exact count and limit with reduction and export guidance', () => {
    const review = vi.fn()
    render(<LegacyOverLimitNotice legacy={legacy} onReviewExports={review} />)

    expect(screen.getByRole('alert')).toHaveTextContent(legacyOverLimitCounts(legacy))
    expect(screen.getByRole('alert')).toHaveTextContent('Export important layouts first')
    expect(screen.getByRole('alert')).toHaveTextContent('close workspaces, panes, or tabs')
    screen.getByRole('button', { name: 'Review export options' }).click()
    expect(review).toHaveBeenCalledOnce()
  })
})
