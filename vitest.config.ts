import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: [
      'electron/**/*.test.ts',
      'benchmarks/**/*.test.ts',
      'shared/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: [
        'benchmarks/**/*.ts',
        'electron/**/*.ts',
        'shared/**/*.ts',
        'src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        'coverage/**',
        'dist/**',
        'dist-electron/**',
        'e2e/**',
        'resources/**',
        'scripts/**',
        'electron/electron-env.d.ts',
        'src/vite-env.d.ts',
      ],
    },
  },
})
