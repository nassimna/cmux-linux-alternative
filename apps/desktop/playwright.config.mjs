import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig } from '@playwright/test'

export default defineConfig({
  outputDir: join(tmpdir(), 'agent-workspace-playwright-results'),
  preserveOutput: 'failures-only',
  reporter: 'line'
})
