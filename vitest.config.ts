import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: [
      'electron/**/*.test.ts',
      'shared/**/*.test.ts',
      'src/**/*.test.ts',
    ],
  },
})
