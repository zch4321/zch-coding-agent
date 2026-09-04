import { describe, expect, it } from 'vitest'
import { approvedCallBrand as compatibilityApprovedCallBrand } from '../tools/approved-tool-call'
import {
  ToolExecutor as CompatibilityToolExecutor,
  ToolRegistry as CompatibilityToolRegistry,
} from '../tools/tool-registry'
import {
  approvedCallBrand,
  createToolCancelled,
  createToolDenied,
  createToolError,
  createToolSuccess,
  createToolTimeout,
  ToolExecutor,
  ToolRegistry,
} from './index'

describe('tooling public API', () => {
  it('keeps legacy imports as aliases of the new implementation source', () => {
    expect(CompatibilityToolRegistry).toBe(ToolRegistry)
    expect(CompatibilityToolExecutor).toBe(ToolExecutor)
    expect(compatibilityApprovedCallBrand).toBe(approvedCallBrand)
  })

  it('constructs every internal Tool result variant explicitly', () => {
    expect(createToolSuccess({ answer: 42 }, { totalBytes: 12 })).toEqual({
      status: 'ok',
      content: { answer: 42 },
      totalBytes: 12,
    })
    expect(createToolError('FAILED', 'failed', true)).toEqual({
      status: 'error',
      code: 'FAILED',
      message: 'failed',
      retryable: true,
    })
    expect(createToolDenied('denied')).toEqual({
      status: 'denied',
      message: 'denied',
    })
    expect(createToolCancelled()).toEqual({
      status: 'cancelled',
      message: 'The run was cancelled',
    })
    expect(createToolTimeout('read_file')).toEqual({
      status: 'timeout',
      message: 'read_file timed out',
    })
  })
})
