import { defineConfig } from 'vite'
import { sourceCommitDefine } from './build/source-identity'

export default defineConfig({
  define: sourceCommitDefine(),
  build: {
    target: 'node24',
    outDir: 'dist-headless',
    emptyOutDir: true,
    ssr: 'electron/headless/main.ts',
    rolldownOptions: {
      external: [
        'node-pty',
        '@vscode/ripgrep',
        // CommonJS package reads __filename, which is absent if inlined into ESM.
        'write-file-atomic',
      ],
      output: {
        entryFileNames: 'zch-agent-headless.mjs',
        format: 'esm',
      },
    },
  },
})
