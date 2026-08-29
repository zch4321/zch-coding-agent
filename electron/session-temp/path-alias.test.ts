import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aliasSessionTempPathFields,
  resolveSessionTempToolPath,
  sessionTempPathForModel,
} from './path-alias'

const sessionTemp = {
  root: path.resolve('C:/temp/session'),
  artifacts: path.resolve('C:/temp/session/artifacts'),
  scratch: path.resolve('C:/temp/session/scratch'),
}

describe('Session temp path aliases', () => {
  it('uses the most specific portable alias and resolves it for file tools', () => {
    const artifact = path.join(
      sessionTemp.artifacts,
      'terminals',
      'terminal-1.log',
    )
    const alias = sessionTempPathForModel(sessionTemp, artifact)

    expect(alias).toBe('ZCH_SESSION_ARTIFACTS_DIR:/terminals/terminal-1.log')
    expect(resolveSessionTempToolPath(alias, sessionTemp)).toBe(artifact)
  })

  it('rewrites only known artifact path fields in nested Tool Results', () => {
    const artifact = path.join(sessionTemp.artifacts, 'swarms', 'manifest.json')

    expect(
      aliasSessionTempPathFields(
        {
          manifestPath: artifact,
          nested: { resultPath: artifact, message: artifact },
        },
        sessionTemp,
      ),
    ).toEqual({
      manifestPath: 'ZCH_SESSION_ARTIFACTS_DIR:/swarms/manifest.json',
      nested: {
        resultPath: 'ZCH_SESSION_ARTIFACTS_DIR:/swarms/manifest.json',
        message: artifact,
      },
    })
  })

  it('leaves workspace paths and unknown aliases unchanged', () => {
    const workspacePath = path.resolve('C:/workspace/result.md')

    expect(sessionTempPathForModel(sessionTemp, workspacePath)).toBe(
      workspacePath,
    )
    expect(resolveSessionTempToolPath('src/app.ts', sessionTemp)).toBe(
      'src/app.ts',
    )
  })
})
