import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadLatestMonthlySwebenchCatalog,
  loadLatestSweRebenchCatalog,
} from '../benchmarks/adapters/external-datasets'
import { ExternalDockerRuntime } from '../benchmarks/adapters/external-docker-runtime'

const runtimeImage = required('ZCH_WORKER_IMAGE')
const sourceCommit = required('ZCH_EXPECTED_SOURCE_COMMIT')

describe('real external benchmark compatibility', () => {
  it('validates one latest Monthly-SWEBench and one SWE-rebench task', async () => {
    const runtime = new ExternalDockerRuntime({
      cacheDirectory: path.resolve('benchmarks/.cache/external-real'),
      runtimeImage,
      sourceCommit,
    })
    const [monthly, rebench] = await Promise.all([
      loadLatestMonthlySwebenchCatalog(),
      loadLatestSweRebenchCatalog(),
    ])

    const monthlyImage = await firstCompatible(monthly.candidates, runtime)
    const rebenchImage = await firstCompatible(
      [...rebench.candidates].sort(rebenchCompatibilityOrder),
      runtime,
    )

    expect(monthlyImage.eligible).toBe(true)
    expect(rebenchImage.eligible).toBe(true)
    expect(monthlyImage.agentImageDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(rebenchImage.agentImageDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })
})

async function firstCompatible(
  candidates: Parameters<ExternalDockerRuntime['resolveImage']>[0][],
  runtime: ExternalDockerRuntime,
) {
  const maximum = Number(process.env.ZCH_EXTERNAL_REAL_MAX_CANDIDATES ?? 8)
  for (const candidate of candidates.slice(0, maximum)) {
    const result = await runtime.resolveImage(candidate)
    if (result.eligible) return result
  }
  throw new Error(
    `No compatible task was found among the first ${maximum} candidates`,
  )
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function rebenchCompatibilityOrder(
  left: Parameters<ExternalDockerRuntime['resolveImage']>[0],
  right: Parameters<ExternalDockerRuntime['resolveImage']>[0],
): number {
  const score = (
    candidate: Parameters<ExternalDockerRuntime['resolveImage']>[0],
  ) =>
    candidate.privatePayload.kind === 'swe-rebench'
      ? candidate.privatePayload.passToPass.length * 1_000_000 +
        candidate.privatePayload.failToPass.length * 1_000 +
        candidate.patchBytes
      : Number.MAX_SAFE_INTEGER
  return score(left) - score(right) || left.caseId.localeCompare(right.caseId)
}
