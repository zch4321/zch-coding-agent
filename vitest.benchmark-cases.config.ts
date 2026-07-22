import vue from '@vitejs/plugin-vue'
import { defaultExclude, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['benchmarks/cases/cases.test.ts'],
    exclude: defaultExclude,
  },
})
