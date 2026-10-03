import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: process.env.SITE ?? 'https://nassimna.github.io',
  base: process.env.WEBSITE_BASE_PATH ?? '/',
  vite: {
    plugins: [tailwindcss()]
  }
})
