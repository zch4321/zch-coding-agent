const { execFileSync, spawnSync } = require('node:child_process')

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim()
}

const commit = process.env.ZCH_SOURCE_COMMIT || git('rev-parse', 'HEAD')
const treeState =
  process.env.ZCH_SOURCE_TREE_STATE ||
  (git('status', '--porcelain') ? 'dirty' : 'clean')
const tag =
  process.env.ZCH_WORKER_IMAGE || `zch-agent-headless:${commit.slice(0, 12)}`
const result = spawnSync(
  'docker',
  [
    'build',
    '--file',
    'benchmarks/docker/headless.Dockerfile',
    '--platform',
    'linux/amd64',
    '--build-arg',
    `ZCH_SOURCE_COMMIT=${commit}`,
    '--build-arg',
    `ZCH_SOURCE_TREE_STATE=${treeState}`,
    '--tag',
    tag,
    '.',
  ],
  { stdio: 'inherit', windowsHide: true },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
process.stdout.write(`${tag}\n`)
