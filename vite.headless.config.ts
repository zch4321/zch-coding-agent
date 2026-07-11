import { defineConfig } from 'vite'
import { sourceCommitDefine } from './build/source-identity'

export default defineConfig({
  define: sourceCommitDefine(),
  build: {
    target: 'node22',
    outDir: 'dist-headless',
    emptyOutDir: true,
    ssr: 'electron/headless/main.ts',
    rolldownOptions: {
      external: ['node-pty', '@vscode/ripgrep'],
      output: {
        entryFileNames: 'zch-agent-headless.mjs',
        format: 'esm',
      },
    },
  },
})
