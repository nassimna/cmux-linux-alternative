import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@agent-workspace/protocol-client'] })]
  },
  preload: {
    // Sandboxed preloads cannot resolve application packages at runtime. Bundle the strict
    // protocol schemas and their Zod runtime so every exposed IPC result is validated before the
    // renderer receives it.
    plugins: [externalizeDepsPlugin({ exclude: ['@agent-workspace/protocol-client', 'zod'] })],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    build: {
      // The packaged CSP is default-src 'self' with no data: fonts, so every font
      // subset must ship as a file instead of being inlined below Vite's 4 KB limit.
      assetsInlineLimit: 0
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
