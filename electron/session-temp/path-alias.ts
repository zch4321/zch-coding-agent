import path from 'node:path'
import type { JsonValue } from '../../shared/json'
import type { SessionTempPaths } from './service'

const MODEL_PATH_FIELDS = new Set([
  'activityPath',
  'artifactPath',
  'manifestPath',
  'resultPath',
])

const SESSION_TEMP_ALIAS_PREFIX = 'ZCH_SESSION_TEMP_DIR:'
const SESSION_ARTIFACTS_ALIAS_PREFIX = 'ZCH_SESSION_ARTIFACTS_DIR:'
const SESSION_SCRATCH_ALIAS_PREFIX = 'ZCH_SESSION_SCRATCH_DIR:'

function relativePathWithin(
  root: string,
  candidate: string,
): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined
  }
  return relative
}

function portableAlias(prefix: string, relative: string): string {
  return relative ? `${prefix}/${relative.split(path.sep).join('/')}` : prefix
}

/** Converts one absolute Session-temp path into a short model-visible tool alias. */
export function sessionTempPathForModel(
  sessionTemp: SessionTempPaths,
  candidate: string,
): string {
  const roots = [
    {
      prefix: SESSION_ARTIFACTS_ALIAS_PREFIX,
      path: sessionTemp.artifacts,
    },
    { prefix: SESSION_SCRATCH_ALIAS_PREFIX, path: sessionTemp.scratch },
    { prefix: SESSION_TEMP_ALIAS_PREFIX, path: sessionTemp.root },
  ]
  for (const root of roots) {
    const relative = relativePathWithin(root.path, candidate)
    if (relative !== undefined) return portableAlias(root.prefix, relative)
  }
  return candidate
}

/** Resolves a portable Session-temp tool alias without applying Shell expansion. */
export function resolveSessionTempToolPath(
  inputPath: string,
  sessionTemp: SessionTempPaths | undefined,
): string {
  const roots = [
    {
      prefix: SESSION_ARTIFACTS_ALIAS_PREFIX,
      path: sessionTemp?.artifacts,
    },
    { prefix: SESSION_SCRATCH_ALIAS_PREFIX, path: sessionTemp?.scratch },
    { prefix: SESSION_TEMP_ALIAS_PREFIX, path: sessionTemp?.root },
  ]
  for (const root of roots) {
    if (
      inputPath !== root.prefix &&
      !inputPath.startsWith(`${root.prefix}/`) &&
      !inputPath.startsWith(`${root.prefix}\\`)
    ) {
      continue
    }
    if (!root.path) {
      throw new Error('Session temp is unavailable for this path alias')
    }
    const suffix = inputPath.slice(root.prefix.length).replace(/^[\\/]+/u, '')
    return path.resolve(root.path, ...suffix.split(/[\\/]+/u).filter(Boolean))
  }
  return inputPath
}

/** Rewrites known artifact path fields in one JSON value for model display. */
export function aliasSessionTempPathFields(
  value: JsonValue,
  sessionTemp: SessionTempPaths,
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => aliasSessionTempPathFields(entry, sessionTemp))
  }
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      MODEL_PATH_FIELDS.has(key) && typeof entry === 'string'
        ? sessionTempPathForModel(sessionTemp, entry)
        : aliasSessionTempPathFields(entry, sessionTemp),
    ]),
  ) as JsonValue
}
