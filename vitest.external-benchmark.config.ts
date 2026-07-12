import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['benchmark-real-tests/**/*.test.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
    fileParallelism: false,
  },
})
