const { spawn } = require('node:child_process')
const path = require('node:path')

const CHILD_MARKER = 'MY_CODING_AGENT_PTY_SMOKE_CHILD'
const NODE_PTY_MODULE = 'MY_CODING_AGENT_NODE_PTY_MODULE'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function runPtySmoke() {
  const pty = require(process.env[NODE_PTY_MODULE] || 'node-pty')
  const terminal = pty.spawn(
    process.platform === 'win32'
      ? 'powershell.exe'
      : process.env.SHELL || '/bin/sh',
    process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-Command', 'Write-Output PTY_OK']
      : ['-lc', 'printf PTY_OK'],
    {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
      name: 'xterm-256color',
    },
  )
  let output = ''
  const timeout = setTimeout(() => {
    terminal.kill()
    console.error('PTY smoke timed out')
    process.exit(1)
  }, 10_000)

  terminal.onData((chunk) => {
    output += chunk
  })
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout)

    if (exitCode === 0 && output.includes('PTY_OK')) {
      console.log(`PTY_OK electron=${process.versions.electron}`)
      process.exit(0)
    }

    console.error(
      `PTY smoke failed: exit=${exitCode} output=${JSON.stringify(output)}`,
    )
    process.exit(1)
  })
}

function runElectronChild() {
  const electron = option('--electron') || require('electron')
  const nodePtyModule = option('--node-pty')
  const child = spawn(electron, [path.resolve(__filename)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [CHILD_MARKER]: '1',
      ...(nodePtyModule
        ? { [NODE_PTY_MODULE]: path.resolve(nodePtyModule) }
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
  runPtySmoke()
} else {
  runElectronChild()
}
