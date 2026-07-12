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
    const rebenchImage = await firstCompatible(rebench.candidates, runtime)

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
  for (const candidate of candidates.slice(0, 8)) {
    const result = await runtime.resolveImage(candidate)
    if (result.eligible) return result
  }
  throw new Error(
    'No compatible task was found among the first eight candidates',
  )
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
