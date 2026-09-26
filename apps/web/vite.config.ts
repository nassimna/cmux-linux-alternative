import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  plugins: [tailwindcss(), react()],
  build: { assetsInlineLimit: 0 },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    env: { NODE_ENV: 'test' },
    restoreMocks: true
  }
})
