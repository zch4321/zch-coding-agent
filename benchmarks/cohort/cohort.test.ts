import { describe, expect, it, vi } from 'vitest'
import {
  loadLatestMonthlySwebenchCatalog,
  loadLatestSweRebenchCatalog,
} from '../adapters/external-datasets'
import type {
  ExternalBenchmarkCandidate,
  ExternalBenchmarkSource,
} from './contracts'
import {
  assertSameCohort,
  buildRollingMixedCohort,
  verifyCohort,
} from './selection'

const digest = (character: string) => `sha256:${character.repeat(64)}`

describe('rolling mixed benchmark cohort', () => {
  it('selects a deterministic 8+8 cohort with source quotas and repository deduplication', async () => {
    const candidates = fixtureCandidates()
    const resolveImage = vi.fn(
      async (candidate: ExternalBenchmarkCandidate) => ({
        eligible: candidate.caseId !== 'monthly-swebench-bug-fix-0',
        reason: 'image_unavailable' as const,
        officialReference: candidate.officialImageReference,
        officialDigest: digest('a'),
        agentImageDigest: digest('b'),
      }),
    )
    const input = {
      releases: [release('monthly-swebench'), release('swe-rebench')],
      candidates,
      seed: 'fixed-seed',
      now: () => new Date('2026-07-12T00:00:00.000Z'),
      resolveImage,
    }
    const first = await buildRollingMixedCohort(input)
    const second = await buildRollingMixedCohort(input)

    expect(first).toEqual(second)
    expect(first.cases).toHaveLength(16)
    expect(
      first.cases.filter((entry) => entry.source === 'monthly-swebench'),
    ).toHaveLength(8)
    expect(
      first.cases.filter((entry) => entry.source === 'swe-rebench'),
    ).toHaveLength(8)
    expect(new Set(first.cases.map((entry) => entry.repository)).size).toBe(16)
    expect(
      first.cases.filter(
        (entry) =>
          entry.classification === 'bug-fix' &&
          entry.source === 'monthly-swebench',
      ),
    ).toHaveLength(4)
    expect(
      first.cases.filter((entry) => entry.classification === 'non-bug'),
    ).toHaveLength(4)
    expect(JSON.stringify(first)).not.toMatch(
      /solutionPatch|testPatch|failToPass|privatePayload/u,
    )
    verifyCohort(first)
  })

  it('rejects cohort drift for paired A/B runs', async () => {
    const base = {
      releases: [release('monthly-swebench'), release('swe-rebench')],
      candidates: fixtureCandidates(),
      now: () => new Date('2026-07-12T00:00:00.000Z'),
      resolveImage: async (candidate: ExternalBenchmarkCandidate) => ({
        eligible: true,
        officialReference: candidate.officialImageReference,
        officialDigest: digest('c'),
        agentImageDigest: digest('d'),
      }),
    }
    const first = await buildRollingMixedCohort({ ...base, seed: 'a' })
    const second = await buildRollingMixedCohort({ ...base, seed: 'b' })
    expect(() => assertSameCohort(first, second)).toThrow('same cohort hash')
  })
})

describe('external dataset latest resolvers', () => {
  it('pins the newest Monthly-SWEBench release and normalizes preview rows', async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/api/datasets?')) {
        return jsonResponse([
          { id: 'UnipatAI/Monthly-SWEBench-2026-04', sha: 'a'.repeat(40) },
          { id: 'UnipatAI/Monthly-SWEBench-2026-05', sha: 'b'.repeat(40) },
        ])
      }
      return textResponse(
        'task_id,bucket,task_name,instruction_md,task_toml,environment_dir,solution_dir,tests_dir\nowner__repo_12345678_abcdef12,bugfix,name,bugfix/owner__repo_12345678_abcdef12/instruction.md,bugfix/owner__repo_12345678_abcdef12/task.toml,bugfix/owner__repo_12345678_abcdef12/environment/,bugfix/owner__repo_12345678_abcdef12/solution/,bugfix/owner__repo_12345678_abcdef12/tests/\n',
      )
    }) as unknown as typeof fetch

    const catalog = await loadLatestMonthlySwebenchCatalog({ fetch: request })
    expect(catalog.release).toMatchObject({
      release: '2026-05',
      commit: 'b'.repeat(40),
    })
    expect(catalog.candidates[0]).toMatchObject({
      caseId: 'owner__repo_12345678_abcdef12',
      repository: 'owner/repo',
      classification: 'bug-fix',
    })
  })

  it('pins the newest SWE-rebench split and keeps verifier fields private', async () => {
    const metadata = {
      sha: 'c'.repeat(40),
      cardData: {
        dataset_info: {
          splits: [{ name: 'test' }, { name: '2026_02' }, { name: '2026_03' }],
        },
      },
    }
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/rows?')) {
        return jsonResponse({
          num_rows: 1,
          rows: [
            {
              row: {
                repo: 'owner/repo',
                instance_id: 'owner__repo-42',
                base_commit: 'd'.repeat(40),
                patch: 'diff --git a/a b/a\n',
                test_patch: 'diff --git a/t b/t\n',
                problem_statement: 'Fix the failure.',
                FAIL_TO_PASS: ['test_target'],
                PASS_TO_PASS: ['test_regression'],
                docker_image: 'swerebench/example:latest',
                install_config: { test_cmd: 'pytest' },
              },
            },
          ],
        })
      }
      return jsonResponse(metadata)
    }) as unknown as typeof fetch

    const catalog = await loadLatestSweRebenchCatalog({ fetch: request })
    expect(catalog.release.release).toBe('2026_03')
    expect(catalog.candidates[0]).toMatchObject({
      caseId: 'owner__repo-42',
      language: 'python',
      officialImageReference: 'swerebench/example:latest',
    })
    expect(catalog.candidates[0]!.privatePayload).toMatchObject({
      kind: 'swe-rebench',
      failToPass: ['test_target'],
    })
  })
})

function fixtureCandidates(): ExternalBenchmarkCandidate[] {
  const values: ExternalBenchmarkCandidate[] = []
  for (const classification of ['bug-fix', 'non-bug'] as const) {
    for (let index = 0; index < 7; index += 1) {
      values.push(
        candidate(
          'monthly-swebench',
          classification,
          index,
          index * 1_000 + 100,
        ),
      )
    }
  }
  for (let index = 0; index < 12; index += 1) {
    values.push(candidate('swe-rebench', 'bug-fix', index, index * 3_000 + 100))
  }
  return values
}

function candidate(
  source: ExternalBenchmarkSource,
  classification: 'bug-fix' | 'non-bug',
  index: number,
  patchBytes: number,
): ExternalBenchmarkCandidate {
  const caseId = `${source}-${classification}-${index}`
  return {
    ...release(source),
    caseId,
    repository: `${source}/${classification}-${index}`,
    classification,
    language: index % 2 ? 'python' : 'go',
    problemStatement: `Task ${caseId}`,
    baseCommit: 'e'.repeat(40),
    patchBytes,
    officialImageReference: `example/${caseId}:latest`,
    privatePayload:
      source === 'monthly-swebench'
        ? {
            kind: 'monthly-swebench',
            archiveFile:
              classification === 'bug-fix'
                ? 'bugfix.tar.zst'
                : 'non_bugfix.tar.zst',
            instructionPath: `${caseId}/instruction.md`,
            taskPath: `${caseId}/task.toml`,
            environmentPath: `${caseId}/environment/`,
            solutionPath: `${caseId}/solution/`,
            testsPath: `${caseId}/tests/`,
          }
        : {
            kind: 'swe-rebench',
            solutionPatch: `solution ${caseId}`,
            testPatch: `tests ${caseId}`,
            failToPass: ['target'],
            passToPass: ['regression'],
            verifier: {},
          },
  }
}

function release(source: ExternalBenchmarkSource) {
  return {
    source,
    dataset: `fixture/${source}`,
    release: '2026-05',
    commit: 'f'.repeat(40),
    adapterRevision: `${source}-v1`,
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  })
}
