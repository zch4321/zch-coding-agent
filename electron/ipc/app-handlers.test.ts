import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mocks are hoisted before the module under test imports them. The handler
// imports `dialog` from 'electron' and `readFile`/`writeFile` from
// 'node:fs/promises' at module scope; we replace those so the handlers can be
// exercised without a real Electron/Node filesystem. vi.hoisted makes the mock
// functions available inside the hoisted vi.mock factories.

const { showSaveDialog, showOpenDialog, readFile, writeFile, stat } =
  vi.hoisted(() => ({
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
  }))

vi.mock('electron', () => ({
  BrowserWindow: {},
  dialog: { showSaveDialog, showOpenDialog },
  shell: {},
}))

vi.mock('node:fs/promises', () => ({ readFile, writeFile, stat }))

// PathGuard is exercised by other handlers; stub it so importing the module
// does not pull in real fs behaviour for the import/export tests.
vi.mock('../safety/path-guard', () => ({
  PathGuard: {},
  PathGuardError: class PathGuardError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

import { createAppIpcHandlers } from './app-handlers'
import { CONVERSATION_MARKDOWN_MAX_BYTES } from '../../shared/ipc-contract'

function createHandlers() {
  return createAppIpcHandlers({
    configStore: {} as never,
    sessionManager: {} as never,
    skillsManager: {} as never,
    traceService: {} as never,
    changeHistory: {} as never,
    workbenchStore: {} as never,
    getMainWindow: () => undefined,
  })
}

// The handlers are invoked directly with a typed payload and a stub event; the
// IPC envelope (sender validation, payload/result schema checks) is exercised
// separately in ipc.test.ts, so here we focus on the business logic.
const stubEvent = {} as never

describe('workbench import/export handlers', () => {
  beforeEach(() => {
    showSaveDialog.mockReset()
    showOpenDialog.mockReset()
    readFile.mockReset()
    writeFile.mockReset()
  })

  it('returns a cancel when the export save dialog is dismissed', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const handlers = createHandlers()
    const result = await handlers['workbench:export-conversation']!(
      {
        version: 1,
        markdown: '# hi',
        suggestedName: 'conversation.md',
      },
      stubEvent,
    )

    expect(result).toEqual({ canceled: true })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('writes the markdown and returns the chosen path on a successful export', async () => {
    showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: 'F:/out/conversation.md',
    })
    writeFile.mockResolvedValue(undefined)
    const handlers = createHandlers()
    const result = await handlers['workbench:export-conversation']!(
      {
        version: 1,
        markdown: '# exported body',
        suggestedName: 'conversation.md',
      },
      stubEvent,
    )

    expect(writeFile).toHaveBeenCalledWith(
      'F:/out/conversation.md',
      '# exported body',
      'utf8',
    )
    expect(result).toEqual({
      canceled: false,
      path: 'F:/out/conversation.md',
    })
  })

  it('returns a cancel when the import open dialog is dismissed', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const handlers = createHandlers()
    const result = await handlers['workbench:import-conversation']!(
      { version: 1 },
      stubEvent,
    )

    expect(result).toEqual({ canceled: true })
    expect(readFile).not.toHaveBeenCalled()
  })

  it('returns the file content on a successful, in-limit import', async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['F:/in/chat.md'],
    })
    const markdown = '---\nschemaVersion: 1\n---\n[]'
    readFile.mockResolvedValue(markdown)
    const handlers = createHandlers()
    const result = await handlers['workbench:import-conversation']!(
      { version: 1 },
      stubEvent,
    )

    expect(readFile).toHaveBeenCalledWith('F:/in/chat.md', 'utf8')
    expect(result).toEqual({ canceled: false, markdown })
  })

  it('returns PAYLOAD_TOO_LARGE (not INTERNAL_ERROR) when the file exceeds the shared limit', async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['F:/in/huge.md'],
    })
    // A document whose UTF-8 byte length is just over the shared contract
    // limit. The handler must fail before result-schema validation can turn a
    // user-actionable size error into an INTERNAL_ERROR.
    const oversized = 'x'.repeat(CONVERSATION_MARKDOWN_MAX_BYTES + 1)
    readFile.mockResolvedValue(oversized)
    const handlers = createHandlers()

    await expect(
      handlers['workbench:import-conversation']!({ version: 1 }, stubEvent),
    ).rejects.toMatchObject({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: expect.stringContaining('size limit'),
      },
    })
  })

  it('returns NOT_FOUND when the selected file cannot be read (ENOENT)', async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['F:/in/missing.md'],
    })
    const readError = Object.assign(new Error('not found'), { code: 'ENOENT' })
    readFile.mockRejectedValue(readError)
    const handlers = createHandlers()

    await expect(
      handlers['workbench:import-conversation']!({ version: 1 }, stubEvent),
    ).rejects.toMatchObject({
      // IpcFault carries the error envelope; NOT_FOUND is user-actionable.
      error: { code: 'NOT_FOUND' },
    })
  })
})
