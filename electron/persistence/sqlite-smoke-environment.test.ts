import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildChildEnvironment } = require('../../scripts/sqlite-smoke.cjs') as {
  buildChildEnvironment(
    source: Record<string, string | undefined>,
    additions: Record<string, string | undefined>,
  ): Record<string, string | undefined>
}

describe('SQLite smoke child environment', () => {
  it('keeps required runtime values without forwarding credentials', () => {
    const environment = buildChildEnvironment(
      {
        PATH: 'C:\\Windows\\System32',
        SYSTEMROOT: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        DEEPSEEK_API_KEY: 'secret-deepseek-key',
        OPENAI_API_KEY: 'secret-openai-key',
        AUTHORIZATION: 'Bearer secret-token',
        NODE_OPTIONS: '--require=untrusted-hook.cjs',
      },
      {
        ELECTRON_RUN_AS_NODE: '1',
        MY_CODING_AGENT_SQLITE_SMOKE_CHILD: '1',
      },
    )

    expect(environment).toEqual({
      PATH: 'C:\\Windows\\System32',
      SYSTEMROOT: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      ELECTRON_RUN_AS_NODE: '1',
      MY_CODING_AGENT_SQLITE_SMOKE_CHILD: '1',
    })
  })
})
