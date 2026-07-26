import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const SOURCE_ROOTS = ['electron', 'shared', 'src', 'benchmarks']
const EXCLUDED_FILE = /(?:\.test|\.spec)\.ts$|test-support|fixtures|\.d\.ts$/u

const exactResponsibilities = new Map([
  ['acquire', 'Acquires the requested resource lease.'],
  ['add', 'Adds the supplied entry.'],
  ['append', 'Appends the supplied value.'],
  ['authorize', 'Authorizes the requested operation.'],
  ['catalog', 'Returns the currently available catalog.'],
  ['clear', 'Clears the accumulated state.'],
  ['close', 'Closes the resource and releases its handles.'],
  ['commit', 'Commits the pending durable mutation.'],
  ['compile', 'Compiles the supplied input.'],
  ['complete', 'Marks the operation as complete.'],
  ['connect', 'Connects the managed resource.'],
  ['create', 'Creates a new instance.'],
  ['delete', 'Deletes the requested record.'],
  ['dispose', 'Releases all owned resources.'],
  ['evaluate', 'Evaluates the supplied request.'],
  ['execute', 'Executes the requested operation.'],
  ['emit', 'Emits an event to registered listeners.'],
  ['forget', 'Removes the entry from runtime tracking.'],
  ['get', 'Returns the requested record.'],
  ['initialize', 'Initializes the component and its dependencies.'],
  ['interrupt', 'Interrupts the active operation.'],
  ['invalidate', 'Invalidates the tracked state.'],
  ['list', 'Lists the currently available records.'],
  ['open', 'Opens the requested resource.'],
  ['prepare', 'Prepares the requested operation.'],
  ['query', 'Queries the configured backend.'],
  ['read', 'Reads the requested data.'],
  ['record', 'Records the supplied event.'],
  ['remove', 'Removes the requested record.'],
  ['restart', 'Restarts the managed resource.'],
  ['reset', 'Resets the tracked state.'],
  ['resize', 'Resizes the managed resource.'],
  ['revert', 'Reverts the requested mutation.'],
  ['rewind', 'Rewinds the requested history branch.'],
  ['retry', 'Retries the requested operation.'],
  ['save', 'Persists the supplied state.'],
  ['search', 'Searches for records matching the request.'],
  ['snapshot', 'Returns a snapshot of the current state.'],
  ['start', 'Starts the requested operation.'],
  ['status', 'Returns the current status.'],
  ['statuses', 'Returns the current statuses.'],
  ['subscribe', 'Subscribes to subsequent events.'],
  ['update', 'Updates the requested record.'],
  ['write', 'Writes the supplied data.'],
])

const verbResponsibilities = [
  [
    'assert',
    (subject) => `Validates ${subject} and throws when it is invalid.`,
  ],
  ['validate', (subject) => `Validates ${subject}.`],
  ['normalize', (subject) => `Normalizes ${subject}.`],
  ['create', (subject) => `Creates ${subject}.`],
  ['build', (subject) => `Builds ${subject}.`],
  ['collect', (subject) => `Collects ${subject}.`],
  ['load', (subject) => `Loads ${subject}.`],
  ['read', (subject) => `Reads ${subject}.`],
  ['parse', (subject) => `Parses ${subject}.`],
  ['render', (subject) => `Renders ${subject}.`],
  ['format', (subject) => `Formats ${subject}.`],
  ['write', (subject) => `Writes ${subject}.`],
  ['save', (subject) => `Persists ${subject}.`],
  ['update', (subject) => `Updates ${subject}.`],
  ['set', (subject) => `Sets ${subject}.`],
  ['mark', (subject) => `Marks ${subject}.`],
  ['delete', (subject) => `Deletes ${subject}.`],
  ['remove', (subject) => `Removes ${subject}.`],
  ['clear', (subject) => `Clears ${subject}.`],
  ['close', (subject) => `Closes ${subject}.`],
  ['dispose', (subject) => `Releases ${subject}.`],
  ['open', (subject) => `Opens ${subject}.`],
  ['start', (subject) => `Starts ${subject}.`],
  ['run', (subject) => `Runs ${subject}.`],
  ['execute', (subject) => `Executes ${subject}.`],
  ['stop', (subject) => `Stops ${subject}.`],
  ['cancel', (subject) => `Cancels ${subject}.`],
  ['interrupt', (subject) => `Interrupts ${subject}.`],
  ['ensure', (subject) => `Ensures ${subject}.`],
  ['resolve', (subject) => `Resolves ${subject}.`],
  ['select', (subject) => `Selects ${subject}.`],
  ['find', (subject) => `Finds ${subject}.`],
  ['search', (subject) => `Searches ${subject}.`],
  ['register', (subject) => `Registers ${subject}.`],
  ['handle', (subject) => `Handles ${subject}.`],
  ['send', (subject) => `Sends ${subject}.`],
  ['emit', (subject) => `Emits ${subject}.`],
  ['apply', (subject) => `Applies ${subject}.`],
  ['prepare', (subject) => `Prepares ${subject}.`],
  ['commit', (subject) => `Commits ${subject}.`],
  ['begin', (subject) => `Begins ${subject}.`],
  ['fail', (subject) => `Marks ${subject} as failed.`],
  ['evict', (subject) => `Evicts ${subject}.`],
  ['reserve', (subject) => `Reserves ${subject}.`],
  ['acquire', (subject) => `Acquires ${subject}.`],
  ['release', (subject) => `Releases ${subject}.`],
  ['bind', (subject) => `Binds ${subject}.`],
  ['restore', (subject) => `Restores ${subject}.`],
  ['rebuild', (subject) => `Rebuilds ${subject}.`],
  ['revalidate', (subject) => `Revalidates ${subject}.`],
  ['reduce', (subject) => `Reduces ${subject}.`],
  ['aggregate', (subject) => `Aggregates ${subject}.`],
  ['add', (subject) => `Adds ${subject}.`],
  ['adopt', (subject) => `Adopts ${subject}.`],
  ['archive', (subject) => `Archives ${subject}.`],
  ['authorize', (subject) => `Authorizes ${subject}.`],
  ['compare', (subject) => `Compares ${subject}.`],
  ['inspect', (subject) => `Inspects ${subject}.`],
  ['clone', (subject) => `Clones ${subject}.`],
  ['compile', (subject) => `Compiles ${subject}.`],
  ['complete', (subject) => `Completes ${subject}.`],
  ['connect', (subject) => `Connects ${subject}.`],
  ['copy', (subject) => `Copies ${subject}.`],
  ['decode', (subject) => `Decodes ${subject}.`],
  ['decrypt', (subject) => `Decrypts ${subject}.`],
  ['defer', (subject) => `Defers ${subject}.`],
  ['detect', (subject) => `Detects ${subject}.`],
  ['disable', (subject) => `Disables ${subject}.`],
  ['encode', (subject) => `Encodes ${subject}.`],
  ['encrypt', (subject) => `Encrypts ${subject}.`],
  ['evaluate', (subject) => `Evaluates ${subject}.`],
  ['filter', (subject) => `Filters ${subject}.`],
  ['fork', (subject) => `Forks ${subject}.`],
  ['grade', (subject) => `Grades ${subject}.`],
  ['hydrate', (subject) => `Hydrates ${subject}.`],
  ['infer', (subject) => `Infers ${subject}.`],
  ['insert', (subject) => `Inserts ${subject}.`],
  ['install', (subject) => `Installs ${subject}.`],
  ['invalidate', (subject) => `Invalidates ${subject}.`],
  ['activate', (subject) => `Activates ${subject}.`],
  ['deactivate', (subject) => `Deactivates ${subject}.`],
  ['truncate', (subject) => `Truncates ${subject} to its configured bound.`],
  ['estimate', (subject) => `Estimates ${subject}.`],
  ['capture', (subject) => `Captures ${subject}.`],
  ['scan', (subject) => `Scans ${subject}.`],
  ['wait', (subject) => `Waits for ${subject}.`],
  ['decide', (subject) => `Records the decision for ${subject}.`],
  ['queue', (subject) => `Queues ${subject}.`],
  ['flush', (subject) => `Flushes ${subject}.`],
  ['append', (subject) => `Appends ${subject}.`],
  ['replace', (subject) => `Replaces ${subject}.`],
  ['convert', (subject) => `Converts ${subject}.`],
  ['transform', (subject) => `Transforms ${subject}.`],
  ['map', (subject) => `Maps ${subject}.`],
  ['omit', (subject) => `Omits ${subject}.`],
  ['bound', (subject) => `Bounds ${subject}.`],
  ['publish', (subject) => `Publishes ${subject}.`],
  ['query', (subject) => `Queries ${subject}.`],
  ['refresh', (subject) => `Refreshes ${subject}.`],
  ['reload', (subject) => `Reloads ${subject}.`],
  ['replay', (subject) => `Replays ${subject}.`],
  ['request', (subject) => `Requests ${subject}.`],
  ['reset', (subject) => `Resets ${subject}.`],
  ['resize', (subject) => `Resizes ${subject}.`],
  ['revert', (subject) => `Reverts ${subject}.`],
  ['rewind', (subject) => `Rewinds ${subject}.`],
  ['score', (subject) => `Scores ${subject}.`],
  ['strip', (subject) => `Strips ${subject}.`],
  ['subscribe', (subject) => `Subscribes to ${subject}.`],
  ['summarize', (subject) => `Summarizes ${subject}.`],
  ['supersede', (subject) => `Supersedes ${subject}.`],
  ['trust', (subject) => `Trusts ${subject}.`],
  ['verify', (subject) => `Verifies ${subject}.`],
]

function collectSourceFiles(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(filePath, files)
    } else if (entry.name.endsWith('.ts') && !EXCLUDED_FILE.test(filePath)) {
      files.push(filePath)
    }
  }
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind))
}

function hasDocComment(node) {
  return (
    ts.canHaveJSDoc(node) &&
    ts.getJSDocCommentsAndTags(node).some((entry) => ts.isJSDoc(entry))
  )
}

function isPublicClassMember(member) {
  return !(
    hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(member, ts.SyntaxKind.ProtectedKeyword) ||
    (member.name && ts.isPrivateIdentifier(member.name))
  )
}

function isCallableClassMember(member) {
  return (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member) ||
    (ts.isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      (ts.isArrowFunction(member.initializer) ||
        ts.isFunctionExpression(member.initializer)))
  )
}

function declarationName(node) {
  if (!node.name) return '<anonymous>'
  return node.name.getText()
}

function normalizedName(name) {
  return name.replace(/^['"]|['"]$/gu, '')
}

function wordsFromIdentifier(identifier) {
  return normalizedName(identifier)
    .replace(/^\[(?:Symbol\.)?(.+)\]$/u, '$1')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim()
    .toLowerCase()
}

function callableResponsibility(name) {
  const normalized = normalizedName(name)
  if (normalized === '[Symbol.dispose]') {
    return 'Releases resources through the synchronous disposal protocol.'
  }
  if (normalized === '[Symbol.asyncDispose]') {
    return 'Releases resources through the asynchronous disposal protocol.'
  }
  const exact = exactResponsibilities.get(normalized)
  if (exact) return exact

  if (/^(?:is|has|can|should)[A-Z_]/u.test(normalized)) {
    return `Determines whether ${wordsFromIdentifier(normalized)}.`
  }
  if (/^to[A-Z_]/u.test(normalized)) {
    return `Converts the input to ${wordsFromIdentifier(normalized.slice(2))}.`
  }
  if (/^from[A-Z_]/u.test(normalized)) {
    return `Creates the result from ${wordsFromIdentifier(normalized.slice(4))}.`
  }
  if (/^get[A-Z_]/u.test(normalized)) {
    return `Returns ${wordsFromIdentifier(normalized.slice(3))}.`
  }
  if (/^list[A-Z_]/u.test(normalized)) {
    return `Lists ${wordsFromIdentifier(normalized.slice(4))}.`
  }

  for (const [prefix, describe] of verbResponsibilities) {
    if (
      !normalized.startsWith(prefix) ||
      !/[A-Z_]/u.test(normalized[prefix.length] ?? '')
    ) {
      continue
    }
    const subject = wordsFromIdentifier(normalized.slice(prefix.length))
    return describe(subject)
  }
  if (
    /(?:Args|Bytes|Content|Count|Definitions|Descriptor|Hash|Id|Key|Markdown|Names|Path|Preview|Signature|Snapshot|State|Status|Text|Value)$/u.test(
      normalized,
    ) ||
    /^(?:pid|stats|stderrTail|stream)$/u.test(normalized)
  ) {
    return `Returns ${wordsFromIdentifier(normalized)}.`
  }
  return `Performs the ${wordsFromIdentifier(normalized)} operation.`
}

function classResponsibility(name) {
  const normalized = normalizedName(name)
  const phrase = wordsFromIdentifier(normalized)
  if (normalized.startsWith('Null')) {
    return `Provides a no-op ${wordsFromIdentifier(normalized.slice(4))} implementation.`
  }
  const suffixes = [
    ['Error', (subject) => `Reports ${subject} failures.`],
    ['Repository', (subject) => `Persists and queries ${subject} records.`],
    ['Service', (subject) => `Provides ${subject} operations.`],
    [
      'Manager',
      (subject) => `Coordinates ${subject} lifecycle and operations.`,
    ],
    ['Coordinator', (subject) => `Coordinates ${subject} workflows.`],
    ['Registry', (subject) => `Registers and resolves ${subject} entries.`],
    ['Adapter', (subject) => `Adapts ${subject} to its host interface.`],
    [
      'Controller',
      (subject) => `Controls ${subject} lifecycle and operations.`,
    ],
    ['Store', (subject) => `Persists and retrieves ${subject} state.`],
    ['Writer', (subject) => `Writes ${subject} output.`],
    ['Reader', (subject) => `Reads ${subject} data.`],
    ['Runtime', (subject) => `Runs ${subject} workflows.`],
    ['Runner', (subject) => `Runs ${subject} workflows.`],
    ['Tracker', (subject) => `Tracks ${subject} state.`],
    ['Pipeline', (subject) => `Applies ${subject} policies in order.`],
    ['Filter', (subject) => `Filters ${subject} input.`],
    ['Pool', (subject) => `Manages pooled ${subject} resources.`],
    ['Emitter', (subject) => `Publishes ${subject} events.`],
    ['Guard', (subject) => `Enforces ${subject} preconditions.`],
    [
      'Searcher',
      (subject) => `Searches ${subject} data within configured bounds.`,
    ],
    ['Resolver', (subject) => `Resolves ${subject} selections.`],
    ['Gateway', (subject) => `Mediates ${subject} calls.`],
    ['Logger', (subject) => `Writes ${subject} log records.`],
    ['Metrics', (subject) => `Accumulates ${subject} metrics.`],
    [
      'Buffer',
      (subject) => `Buffers ${subject} data within configured bounds.`,
    ],
    [
      'Port',
      (subject) =>
        `Exposes ${subject} operations across an architectural boundary.`,
    ],
    ['Connection', (subject) => `Manages ${subject} connection lifecycle.`],
    [
      'Compiler',
      (subject) => `Compiles ${subject} into its runtime representation.`,
    ],
    ['Planner', (subject) => `Plans ${subject} workflow steps.`],
  ]
  for (const [suffix, describe] of suffixes) {
    if (!normalized.endsWith(suffix) || normalized === suffix) continue
    return describe(wordsFromIdentifier(normalized.slice(0, -suffix.length)))
  }
  return `Encapsulates ${phrase} behavior.`
}

function exportedLocalNames(sourceFile) {
  const names = new Set()
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text)
      }
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      names.add(statement.expression.text)
    }
  }
  return names
}

function isExported(node, explicitNames) {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    (node.name &&
      ts.isIdentifier(node.name) &&
      explicitNames.has(node.name.text))
  )
}

function groupIsDocumented(nodes) {
  return nodes.some((node) => hasDocComment(node))
}

function publicDeclarations(sourceFile) {
  const declarations = []
  const explicitNames = exportedLocalNames(sourceFile)

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement)) {
      declarations.push({
        node: statement,
        nodes: [statement],
        kind: 'class',
        name: declarationName(statement),
      })
      const handledMembers = new Set()
      for (const member of statement.members) {
        if (
          handledMembers.has(member) ||
          ts.isConstructorDeclaration(member) ||
          !isCallableClassMember(member) ||
          !isPublicClassMember(member)
        ) {
          continue
        }
        const name = declarationName(member)
        const overloads = statement.members.filter(
          (candidate) =>
            !ts.isConstructorDeclaration(candidate) &&
            isCallableClassMember(candidate) &&
            isPublicClassMember(candidate) &&
            declarationName(candidate) === name,
        )
        for (const overload of overloads) handledMembers.add(overload)
        declarations.push({
          node: overloads[0],
          nodes: overloads,
          kind: 'method',
          name,
        })
      }
      continue
    }

    if (
      ts.isFunctionDeclaration(statement) &&
      isExported(statement, explicitNames)
    ) {
      const name = declarationName(statement)
      const overloads = sourceFile.statements.filter(
        (candidate) =>
          ts.isFunctionDeclaration(candidate) &&
          declarationName(candidate) === name &&
          isExported(candidate, explicitNames),
      )
      if (overloads[0] === statement) {
        declarations.push({
          node: statement,
          nodes: overloads,
          kind: 'function',
          name,
        })
      }
      continue
    }

    if (!ts.isVariableStatement(statement)) continue
    const statementExported = hasModifier(
      statement,
      ts.SyntaxKind.ExportKeyword,
    )
    const callables = statement.declarationList.declarations.filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer)) &&
        (statementExported || explicitNames.has(declaration.name.text)),
    )
    for (const callable of callables) {
      declarations.push({
        node: statement,
        nodes: [statement, callable],
        kind: 'function',
        name: callable.name.getText(),
      })
    }
  }

  return declarations
}

function lineNumber(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  )
}

function indentationAt(text, position) {
  const lineStart = Math.max(text.lastIndexOf('\n', position - 1) + 1, 0)
  return text.slice(lineStart, position)
}

function inspectFile(filePath, fix) {
  let text = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const missing = publicDeclarations(sourceFile).filter(
    (declaration) => !groupIsDocumented(declaration.nodes),
  )
  if (!fix || missing.length === 0) return { missing, fixed: 0 }

  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const insertions = missing
    .map((declaration) => {
      const position = declaration.node.getStart(sourceFile)
      const responsibility =
        declaration.kind === 'class'
          ? classResponsibility(declaration.name)
          : callableResponsibility(declaration.name)
      return {
        position,
        content: `/** ${responsibility} */${newline}${indentationAt(text, position)}`,
      }
    })
    .sort((left, right) => right.position - left.position)

  for (const insertion of insertions) {
    text =
      text.slice(0, insertion.position) +
      insertion.content +
      text.slice(insertion.position)
  }
  fs.writeFileSync(filePath, text, 'utf8')
  return { missing: [], fixed: insertions.length }
}

const fix = process.argv.includes('--fix')
const files = []
for (const root of SOURCE_ROOTS) collectSourceFiles(root, files)

const missing = []
let fixed = 0
for (const filePath of files.sort()) {
  const result = inspectFile(filePath, fix)
  fixed += result.fixed
  if (result.missing.length === 0) continue
  const sourceFile = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  for (const declaration of result.missing) {
    missing.push(
      `${filePath}:${lineNumber(sourceFile, declaration.node)} ${declaration.kind} ${declaration.name}`,
    )
  }
}

if (fix) {
  process.stdout.write(`Added ${fixed} public API comments.\n`)
} else if (missing.length > 0) {
  process.stderr.write(
    `Missing ${missing.length} public API comments:\n${missing.join('\n')}\n`,
  )
  process.exitCode = 1
} else {
  process.stdout.write('All public classes and callable APIs are documented.\n')
}
