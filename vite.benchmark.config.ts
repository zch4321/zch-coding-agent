import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node24',
    outDir: 'dist-benchmark',
    emptyOutDir: true,
    ssr: 'benchmarks/cli/main.ts',
    rolldownOptions: {
      output: {
        entryFileNames: 'zch-benchmark.mjs',
        format: 'esm',
      },
    },
  },
})
