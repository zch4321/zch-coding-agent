const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CHILD_MARKER = 'MY_CODING_AGENT_SQLITE_SMOKE_CHILD'
const RUNTIME_LABEL = 'MY_CODING_AGENT_SQLITE_RUNTIME'

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function runSqliteSmoke() {
  const { DatabaseSync } = require('node:sqlite')
  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'zch-sqlite-smoke-'),
  )
  const databasePath = path.join(tempDirectory, 'agent.db')
  let database

  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    })
    database.exec('PRAGMA foreign_keys = ON')
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA busy_timeout = 5000')
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      ) STRICT;
    `)
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE smoke_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    database
      .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
      .run(1, '0001_smoke')
    database
      .prepare('INSERT INTO smoke_probe (id, value) VALUES (?, ?)')
      .run(1, 'ok')
    database.exec('COMMIT')
    database.close()

    database = new DatabaseSync(databasePath, { readOnly: true })
    const row = database
      .prepare(
        `SELECT smoke_probe.value, schema_migrations.name
         FROM smoke_probe, schema_migrations
         WHERE smoke_probe.id = ? AND schema_migrations.version = ?`,
      )
      .get(1, 1)
    if (row?.value !== 'ok' || row.name !== '0001_smoke') {
      throw new Error(`Unexpected SQLite round-trip result: ${row?.value}`)
    }
    database.close()
    database = undefined

    console.log(
      [
        'SQLITE_OK',
        `runtime=${process.env[RUNTIME_LABEL] || 'node'}`,
        `node=${process.versions.node}`,
        `electron=${process.versions.electron || 'none'}`,
        `sqlite=${process.versions.sqlite}`,
      ].join(' '),
    )
  } finally {
    if (database?.isOpen) database.close()
    fs.rmSync(tempDirectory, { recursive: true, force: true })
  }
}

function packagedElectronPath() {
  const packageJson = require('../package.json')
  const unpackedDirectory = path.resolve(
    __dirname,
    '..',
    'release',
    packageJson.version,
    'win-unpacked',
  )
  const candidates = fs
    .readdirSync(unpackedDirectory)
    .filter((name) => name.endsWith('.exe') && name !== 'elevate.exe')

  if (candidates.length !== 1) {
    throw new Error(
      `Expected one packaged executable in ${unpackedDirectory}, found ${candidates.length}`,
    )
  }
  return path.join(unpackedDirectory, candidates[0])
}

function runElectronChild() {
  const packaged = process.argv.includes('--packaged')
  if (packaged && process.platform !== 'win32') {
    console.log(
      [
        'SQLITE_SKIP',
        'runtime=electron-packaged',
        'target=win32',
        `host=${process.platform}`,
        'reason=cross-target-executable',
      ].join(' '),
    )
    return
  }
  const electron = packaged
    ? packagedElectronPath()
    : option('--electron') || require('electron')
  const child = spawn(electron, [path.resolve(__filename)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      [CHILD_MARKER]: '1',
      [RUNTIME_LABEL]: packaged ? 'electron-packaged' : 'electron',
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
  runSqliteSmoke()
} else {
  runSqliteSmoke()
  runElectronChild()
}
