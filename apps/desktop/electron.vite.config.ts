import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const webRoot = fileURLToPath(new URL('../web/', import.meta.url))

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@agent-workspace/client-runtime',
          '@agent-workspace/contracts',
          '@agent-workspace/protocol-client'
        ]
      })
    ]
  },
  preload: {
    // Sandboxed preloads cannot resolve application packages at runtime. Bundle the strict
    // protocol schemas and their Zod runtime so every exposed IPC result is validated before the
    // renderer receives it.
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@agent-workspace/contracts', '@agent-workspace/protocol-client', 'zod']
      })
    ],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root: webRoot,
    build: {
      // The packaged CSP is default-src 'self' with no data: fonts, so every font
      // subset must ship as a file instead of being inlined below Vite's 4 KB limit.
      assetsInlineLimit: 0,
      rollupOptions: { input: join(webRoot, 'index.html') }
    },
    plugins: [
      tailwindcss(),
      react(),
      {
        name: 'agent-workspace-development-csp',
        transformIndexHtml(html, context) {
          if (!context.server) {
            return html
          }
          return html
            .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
            .replace("connect-src 'self'", "connect-src 'self' ws:")
        }
      }
    ]
  }
})
