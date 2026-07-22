/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    VITE_DEV_SERVER_URL?: string
  }
}

declare module '*.sql?raw' {
  const source: string
  export default source
}
