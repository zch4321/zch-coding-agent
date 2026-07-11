import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'dist-worker',
    emptyOutDir: true,
    ssr: true,
    rolldownOptions: {
      input: {
        'provider-proxy': path.resolve('benchmarks/worker/provider-proxy.ts'),
        'fake-provider': path.resolve('benchmarks/worker/fake-provider.ts'),
      },
      output: {
        entryFileNames: '[name].mjs',
        format: 'esm',
      },
    },
  },
})
