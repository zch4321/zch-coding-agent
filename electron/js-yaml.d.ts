declare module 'js-yaml' {
  export interface LoadOptions {
    schema?: unknown
    json?: boolean
    filename?: string
  }

  export const JSON_SCHEMA: unknown
  export function load(input: string, options?: LoadOptions): unknown
}
