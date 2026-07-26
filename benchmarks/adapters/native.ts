import type {
  AgentCaseDescriptor,
  LoadedBenchmarkCase,
  LoadedBenchmarkSuite,
} from '../cases/contracts'
import { loadBenchmarkSuite } from '../cases/loader'
import { sha256Bytes } from '../cases/hash'
import { prepareBenchmarkWorkspace } from '../cases/prepare'
import { collectBenchmarkPatch } from '../runner/native-evaluator'
import { runIsolatedGrader } from '../grader/coordinator'
import type { BenchmarkCaseAdapter } from './contracts'

export const NATIVE_ADAPTER_REVISION = 'native-v1'

export const nativeBenchmarkAdapter: BenchmarkCaseAdapter = {
  id: 'native',
  revision: NATIVE_ADAPTER_REVISION,
  executionImage(input) {
    return {
      image: input.defaultImage,
      runtimeImageDigest: input.defaultImageDigest,
    }
  },
  toAgentCaseDescriptor,
  async prepareWorkspace(input) {
    await prepareBenchmarkWorkspace(input)
    return {
      directory: input.destination,
      mount: { kind: 'bind', directory: input.destination },
    }
  },
  capturePatch(input) {
    return collectBenchmarkPatch({
      workspace: input.workspace.directory,
      maxPatchBytes: input.loadedCase.manifest.modificationScope.maxPatchBytes,
    })
  },
  runGrader(input, override) {
    return (override ?? runIsolatedGrader)(input)
  },
}

export type NativeBenchmarkSuite = LoadedBenchmarkSuite & {
  adapter: {
    id: 'native'
    revision: typeof NATIVE_ADAPTER_REVISION
  }
  caseAdapter: typeof nativeBenchmarkAdapter
  suiteIdentitySha256: string
}

/** Loads native benchmark suite. */
export async function loadNativeBenchmarkSuite(input: {
  benchmarkRoot: string
  suiteFile: string
}): Promise<NativeBenchmarkSuite> {
  const loaded = await loadBenchmarkSuite(input)
  const adapter = { id: 'native', revision: NATIVE_ADAPTER_REVISION } as const
  return {
    ...loaded,
    adapter,
    caseAdapter: nativeBenchmarkAdapter,
    suiteIdentitySha256: sha256Bytes(
      JSON.stringify({
        schemaVersion: 1,
        adapter,
        suiteSha256: loaded.suiteSha256,
      }),
    ),
  }
}

/** Converts the input to agent case descriptor. */
export function toAgentCaseDescriptor(
  loaded: LoadedBenchmarkCase,
): AgentCaseDescriptor {
  const manifest = loaded.manifest
  return {
    schemaVersion: 1,
    caseId: manifest.id,
    suiteId: manifest.suite.id,
    suiteRevision: manifest.suite.revision,
    task: manifest.task,
    publicChecks: structuredClone(manifest.publicChecks),
    modificationScope: structuredClone(manifest.modificationScope),
    resources: structuredClone(manifest.resources),
  }
}
