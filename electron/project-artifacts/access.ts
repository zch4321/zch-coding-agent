import path from 'node:path'
import type { ArtifactKind } from '../../shared/project-artifacts'
import type { SessionTempPaths } from '../session-temp/service'

export interface ProjectArtifactAccess {
  path(segments: readonly string[], create: boolean): Promise<string>
  finish(segments: readonly string[], error?: string): Promise<void>
  resolveLegacy(candidate: string): string
  resolveAlias?(root: 'root' | 'artifacts' | 'scratch', suffix: string): string
  validate?(candidate: string): Promise<void>
  available?(segments: readonly string[]): boolean
}

/** Checks durable capture availability without trusting files recreated after collection. */
export function artifactCaptureAvailable(
  sessionTemp: SessionTempPaths,
  segments: readonly string[],
): boolean {
  return sessionTemp.artifactAccess?.available?.(segments) ?? true
}

/** Resolves producer segments through the project registry, preserving legacy fixture contexts. */
export async function artifactPathFor(
  sessionTemp: SessionTempPaths,
  segments: readonly string[],
  create = true,
): Promise<string> {
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      /[\\/\0]/u.test(segment)
    )
      throw new Error('Invalid artifact path segment')
  }
  return sessionTemp.artifactAccess
    ? sessionTemp.artifactAccess.path(segments, create)
    : path.join(sessionTemp.artifacts, ...segments)
}

/** Seals an application-owned capture after all output writers have stopped. */
export async function finishArtifact(
  sessionTemp: SessionTempPaths | undefined,
  segments: readonly string[],
  error?: string,
): Promise<void> {
  await sessionTemp?.artifactAccess?.finish(segments, error)
}

/** Parses the fixed producer layouts without allowing arbitrary artifact namespaces. */
export function artifactSegments(segments: readonly string[]): {
  kind: ArtifactKind
  sourceKey: string
  suffix: string[]
} {
  const [kind, key, ...suffix] = segments
  if (
    !key ||
    ![
      'commands',
      'terminals',
      'subagents',
      'swarms',
      'fetch',
      'web-search',
      'mcp',
    ].includes(kind)
  )
    throw new Error('Unsupported artifact layout')
  return {
    kind: kind as ArtifactKind,
    sourceKey: ['web-search', 'mcp'].includes(kind)
      ? key.replace(/\.json$/u, '')
      : key,
    suffix,
  }
}
