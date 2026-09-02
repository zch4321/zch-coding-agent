import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'
import { sourceCommitDefine } from './build/source-identity'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  base: './',
  define: sourceCommitDefine(),
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rolldownOptions: {
              external: [
                'node-pty',
                '@vscode/ripgrep',
                // CommonJS package reads __filename, which is absent if inlined into ESM.
                'write-file-atomic',
              ],
            },
          },
        },
      },
      preload: {
        input: path.join(currentDirectory, 'electron/preload.ts'),
      },
    }),
  ],
})
