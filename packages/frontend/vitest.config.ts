import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(here, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: { url: 'http://localhost/' },
    },
    setupFiles: ['./tests/setup.ts'],
    css: false,
    globals: false,
  },
})
