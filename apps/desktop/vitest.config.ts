import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      reporter: ['text', 'html']
    },
    include: ['src/**/*.test.{ts,tsx}'],
    env: {
      NODE_ENV: 'test'
    },
    restoreMocks: true
  }
})
