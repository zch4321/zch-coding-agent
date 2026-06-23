import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'vite-plugin-electron/simple'
import vue from '@vitejs/plugin-vue'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  base: './',
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            rolldownOptions: {
              external: ['node-pty', '@vscode/ripgrep'],
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
