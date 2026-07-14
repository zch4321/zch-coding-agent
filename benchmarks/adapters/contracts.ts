import type {
  AgentCaseDescriptor,
  BenchmarkSuite,
  LoadedBenchmarkCase,
} from '../cases/contracts'
import type { IsolatedGraderRunResult } from '../grader/contracts'
import type {
  IsolatedGraderRunner,
  RunIsolatedGraderInput,
} from '../grader/coordinator'
import type { DockerWorkerWorkspace } from '../worker/contracts'

export interface BenchmarkPreparedWorkspace {
  directory: string
  mount?: DockerWorkerWorkspace
}

export interface BenchmarkCaseAdapter {
  id: 'native' | 'monthly-swebench' | 'swe-rebench'
  revision: string
  executionImage(input: {
    loadedCase: LoadedBenchmarkCase
    defaultImage: string
    defaultImageDigest: string
  }): { image: string; runtimeImageDigest: string }
  toAgentCaseDescriptor(loadedCase: LoadedBenchmarkCase): AgentCaseDescriptor
  prepareWorkspace(input: {
    loadedCase: LoadedBenchmarkCase
    destination: string
  }): Promise<BenchmarkPreparedWorkspace>
  capturePatch(input: {
    loadedCase: LoadedBenchmarkCase
    workspace: BenchmarkPreparedWorkspace
  }): Promise<string>
  runGrader(
    input: RunIsolatedGraderInput,
    override?: IsolatedGraderRunner,
  ): Promise<IsolatedGraderRunResult>
  disposeCaseResources?(loadedCase: LoadedBenchmarkCase): Promise<void>
}

export interface LoadedAdapterSuite {
  suite: BenchmarkSuite
  suiteSha256: string
  cases: LoadedBenchmarkCase[]
  adapter: { id: BenchmarkCaseAdapter['id']; revision: string }
  caseAdapter: BenchmarkCaseAdapter
  suiteIdentitySha256: string
}
