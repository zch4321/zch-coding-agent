const { spawn } = require('node:child_process')
const path = require('node:path')

const CHILD_MARKER = 'MY_CODING_AGENT_RIPGREP_SMOKE_CHILD'
const RIPGREP_MODULE = 'MY_CODING_AGENT_RIPGREP_MODULE'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function resolveRgPath() {
  const modulePath = process.env[RIPGREP_MODULE] || '@vscode/ripgrep'
  const resolved = require(modulePath).rgPath

  if (!resolved) {
    throw new Error('rgPath resolved to an empty value')
  }

  return resolved
}

function detectPlatformPackage(rgPath) {
  const match = rgPath.match(/@vscode[/\\]ripgrep-[^/\\]+/u)

  return match ? match[0].replace(/[/\\]/u, '/') : 'unknown'
}

function runRipgrepSmoke() {
  let rgPath

  try {
    rgPath = resolveRgPath()
  } catch (error) {
    console.error(
      `ripgrep smoke failed to resolve rgPath: ${error instanceof Error ? error.message : error}`,
    )
    process.exit(1)
  }

  const child = spawn(rgPath, ['--version'], { windowsHide: true })
  let output = ''

  const timeout = setTimeout(() => {
    child.kill()
    console.error('ripgrep smoke timed out')
    process.exit(1)
  }, 10_000)

  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  child.on('error', (error) => {
    clearTimeout(timeout)
    console.error(`ripgrep smoke failed to spawn: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => {
    clearTimeout(timeout)

    if (code === 0 && /ripgrep/u.test(output)) {
      console.log(
        `RG_OK platform=${detectPlatformPackage(rgPath)} path=${rgPath}`,
      )
      process.exit(0)
    }

    console.error(
      `ripgrep smoke failed: exit=${code} output=${JSON.stringify(output)}`,
    )
    process.exit(1)
  })
}

function runElectronChild() {
  const electron = option('--electron') || require('electron')
  const ripgrepModule = option('--ripgrep')
  const child = spawn(electron, [path.resolve(__filename)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [CHILD_MARKER]: '1',
      ...(ripgrepModule
        ? { [RIPGREP_MODULE]: path.resolve(ripgrepModule) }
        : {}),
    },
    stdio: 'inherit',
    windowsHide: true,
  })

  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })
}

if (process.env[CHILD_MARKER] === '1') {
  runRipgrepSmoke()
} else {
  runElectronChild()
}
