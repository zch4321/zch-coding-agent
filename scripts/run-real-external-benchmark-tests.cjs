const { execFileSync, spawnSync } = require('node:child_process')

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

const commit = git('rev-parse', 'HEAD')
const image =
  process.env.ZCH_WORKER_IMAGE || `zch-agent-headless:${commit.slice(0, 12)}`
if (process.env.ZCH_SKIP_WORKER_IMAGE_BUILD !== '1') {
  const build = spawnSync('node', ['scripts/build-worker-image.cjs'], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ZCH_WORKER_IMAGE: image },
  })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const tests = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.external-benchmark.config.ts',
  ],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ZCH_WORKER_IMAGE: image,
      ZCH_EXPECTED_SOURCE_COMMIT: commit,
    },
  },
)
if (tests.error) throw tests.error
process.exit(tests.status ?? 1)
