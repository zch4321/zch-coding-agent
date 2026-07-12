import type {
  AgentCaseDescriptor,
  LoadedBenchmarkCase,
} from '../cases/contracts'
import type { IsolatedGraderRunResult } from '../grader/contracts'
import type {
  IsolatedGraderRunner,
  RunIsolatedGraderInput,
} from '../grader/coordinator'

export interface BenchmarkPreparedWorkspace {
  directory: string
}

export interface BenchmarkCaseAdapter {
  id: 'native' | 'monthly-swebench' | 'swe-rebench'
  revision: string
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
}

export interface LoadedAdapterSuite {
  adapter: BenchmarkCaseAdapter
  suiteIdentitySha256: string
}
