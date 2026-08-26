import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    tsconfigPaths({
      ignoreConfigErrors: true,
    }),
  ],
  test: {
    environment: 'node',
    hookTimeout: 30_000,
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
