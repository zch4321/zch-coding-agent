import type { ExternalBenchmarkCandidate } from '../cohort/contracts'

const MAX_EXTERNAL_CPUS = 8
const MAX_EXTERNAL_MEMORY_BYTES = 32 * 1024 * 1024 * 1024
const MAX_EXTERNAL_STORAGE_BYTES = 32 * 1024 * 1024 * 1024
const MAX_EXTERNAL_VERIFIER_SECONDS = 2 * 60 * 60

/** Reports that an external benchmark exceeds its configured resource limits. */
export class ExternalResourceLimitError extends Error {}

/** Infers the implementation language from monthly SWE-bench task metadata. */
export function inferMonthlyLanguage(taskToml: string): string {
  const value = taskToml.toLowerCase()
  for (const language of [
    'python',
    'go',
    'rust',
    'java',
    'typescript',
    'javascript',
    'c++',
    'c',
  ]) {
    if (new RegExp(`['"]${language.replace('+', '\\+')}['"]`, 'u').test(value))
      return language
  }
  return 'unknown'
}

/** Checks CPU, memory, storage, and verifier timeout limits for a monthly task. */
export function assertMonthlyResources(taskToml: string): void {
  const cpus = tomlNumber(taskToml, 'cpus')
  const memoryMb = tomlNumber(taskToml, 'memory_mb')
  const storageMb = tomlNumber(taskToml, 'storage_mb')
  const verifierSeconds = tomlNumber(taskToml, 'timeout_sec')
  if (
    (cpus !== undefined && cpus > MAX_EXTERNAL_CPUS) ||
    (memoryMb !== undefined &&
      memoryMb * 1024 * 1024 > MAX_EXTERNAL_MEMORY_BYTES) ||
    (storageMb !== undefined &&
      storageMb * 1024 * 1024 > MAX_EXTERNAL_STORAGE_BYTES) ||
    (verifierSeconds !== undefined &&
      verifierSeconds > MAX_EXTERNAL_VERIFIER_SECONDS)
  ) {
    throw new ExternalResourceLimitError(
      'Monthly-SWEBench task exceeds the external resource boundary',
    )
  }
}

/** Checks SWE-rebench verifier and resource settings against the supported limits. */
export function assertRebenchResources(
  candidate: ExternalBenchmarkCandidate,
): void {
  if (candidate.privatePayload.kind !== 'swe-rebench') return
  const verifier = candidate.privatePayload.verifier
  const cpus = numericValue(verifier.cpus)
  const memory = resourceBytes(verifier.memory)
  const storage = resourceBytes(verifier.storage)
  const timeout = numericValue(verifier.verifierTimeoutSeconds)
  if (
    (cpus !== undefined && cpus > MAX_EXTERNAL_CPUS) ||
    (memory !== undefined && memory > MAX_EXTERNAL_MEMORY_BYTES) ||
    (storage !== undefined && storage > MAX_EXTERNAL_STORAGE_BYTES) ||
    (timeout !== undefined && timeout > MAX_EXTERNAL_VERIFIER_SECONDS)
  ) {
    throw new ExternalResourceLimitError(
      'SWE-rebench task exceeds the external resource boundary',
    )
  }
}

function tomlNumber(value: string, key: string): number | undefined {
  const match = value.match(
    new RegExp(`^\\s*${key}\\s*=\\s*([0-9.]+)\\s*$`, 'mu'),
  )
  return match ? Number(match[1]) : undefined
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function resourceBytes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^([0-9.]+)\s*(b|kb|mb|gb|k|m|g)?$/iu)
  if (!match) return undefined
  const unit = (match[2] ?? 'b').toLowerCase()
  const multiplier = unit.startsWith('g')
    ? 1024 ** 3
    : unit.startsWith('m')
      ? 1024 ** 2
      : unit.startsWith('k')
        ? 1024
        : 1
  return Number(match[1]) * multiplier
}
