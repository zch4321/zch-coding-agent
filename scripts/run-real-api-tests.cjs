const path = require('node:path')
const { spawnSync } = require('node:child_process')

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error(
    'DEEPSEEK_API_KEY is required. The value is read only by the main-process test and is never printed.',
  )
  process.exit(2)
}

const vitest = path.join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'electron/agent/real-api.test.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: { ...process.env, RUN_REAL_API_TESTS: '1' },
  },
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
