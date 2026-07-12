import type {
  AgentCaseDescriptor,
  LoadedBenchmarkCase,
  LoadedBenchmarkSuite,
} from '../cases/contracts'
import { loadBenchmarkSuite } from '../cases/loader'
import { sha256Bytes } from '../cases/hash'

export const NATIVE_ADAPTER_REVISION = 'native-v1'

export type NativeBenchmarkSuite = LoadedBenchmarkSuite & {
  adapter: {
    id: 'native'
    revision: typeof NATIVE_ADAPTER_REVISION
  }
  suiteIdentitySha256: string
}

export async function loadNativeBenchmarkSuite(input: {
  benchmarkRoot: string
  suiteFile: string
}): Promise<NativeBenchmarkSuite> {
  const loaded = await loadBenchmarkSuite(input)
  const adapter = { id: 'native', revision: NATIVE_ADAPTER_REVISION } as const
  return {
    ...loaded,
    adapter,
    suiteIdentitySha256: sha256Bytes(
      JSON.stringify({
        schemaVersion: 1,
        adapter,
        suiteSha256: loaded.suiteSha256,
      }),
    ),
  }
}

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
