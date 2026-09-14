import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import sharp from 'sharp'
import { ConfigStore } from '../config/store'
import { SecretStore } from '../config/secret-store'
import {
  createBackendRuntime,
  type BackendRuntime,
} from './create-backend-runtime'
import { PROVIDER_NOTICE_VERSION } from '../../shared/notices'
import type { SessionId, ProjectId } from '../../shared/ids'
import type { DurableRunStartPayload } from '../../shared/domain-state-api'
import type { Attachment } from '../../shared/attachments'

let root: string
let backend: BackendRuntime
let store: ConfigStore
let projectId: ProjectId
const requests: Record<string, unknown>[] = []
let failCompression = false

beforeEach(async () => {
  requests.length = 0
  failCompression = false
  root = await mkdtemp(path.join(os.tmpdir(), 'zch-multimodal-'))
  await mkdir(path.join(root, 'workspace'))
  store = new ConfigStore(
    path.join(root, 'config.json'),
    new SecretStore(path.join(root, 'secrets.json'), {
      platform: 'win32',
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'test',
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async (value) => ({
        result: value.toString(),
        shouldReEncrypt: false,
      }),
    }),
    { environmentApiKey: 'test-key' },
  )
  await store.initialize()
  await setImageSupport('supported')
  await store.update({
    version: 1,
    kind: 'privacy',
    providerNoticeAccepted: {
      version: PROVIDER_NOTICE_VERSION,
      acceptedAt: new Date().toISOString(),
    },
  })
  backend = await openBackend()
  const added = await backend.projects.add({
    path: path.join(root, 'workspace'),
  })
  projectId = added.commit.change.projects[0].id
})
afterEach(async () => {
  await backend?.dispose()
  await rm(root, { recursive: true, force: true })
})

async function setImageSupport(imageInput: 'supported' | 'unsupported') {
  const provider = store.getPublicConfig().models.providers[0]
  await store.update({
    version: 1,
    kind: 'provider-settings',
    providerId: provider.id,
    label: 'Test vision',
    providerType: 'generic.chat-completions',
    baseURL: 'https://example.test/v1',
    model: 'vision-test',
    enabledModelIds: ['vision-test'],
    modelOverrides: { 'vision-test': { imageInput } },
  })
}

async function openBackend(): Promise<BackendRuntime> {
  return createBackendRuntime({
    configStore: store,
    databasePath: path.join(root, 'state.db'),
    runtimeDataDirectory: path.join(root, 'profile'),
    sessionTempRootDirectory: path.join(root, 'tmp'),
    promptDirectory: path.resolve('resources/prompts'),
    conversationTitlingDisabled: true,
    fetchImpl: vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      const compact = !Object.hasOwn(body, 'tools')
      if (compact && failCompression)
        return new Response('compression rejected', { status: 400 })
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: compact ? 'Image summary: blue rectangle.' : 'Image inspected.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
      )
    }) as typeof fetch,
  })
}

async function importImage(): Promise<Attachment> {
  const source = path.join(root, 'blue.png')
  await sharp({
    create: { width: 32, height: 24, channels: 3, background: '#0088ff' },
  })
    .png()
    .toFile(source)
  const image = await backend.attachments.importLocalFile(
    { projectId, draftKey: 'new' },
    source,
  )
  await rm(source)
  return image
}

function newInput(
  attachment: Attachment,
  suffix = 'first',
): DurableRunStartPayload {
  return {
    version: 1,
    kind: 'new_session',
    sessionId: `session:${suffix}` as SessionId,
    projectId,
    permissionMode: 'readonly',
    modelSelection: {
      providerId: 'deepseek',
      model: 'vision-test',
      reasoning: 'off',
    },
    message: '',
    attachmentIds: [attachment.id],
    clientRequestId: `request:${suffix}`,
  }
}

async function start(input: DurableRunStartPayload) {
  const result = await backend.runs.start(input)
  if (result.outcome !== 'started') throw new Error('Expected started run')
  await backend.runtime.services.sessions.waitForRunSettled(
    input.sessionId,
    result.runId,
  )
  return result
}

describe('durable multimodal turns', () => {
  it('sends attachment-only input, persists no Base64, deduplicates after restart and rejects changed attachment identity', async () => {
    const image = await importImage()
    const input = newInput(image)
    await start(input)
    expect(JSON.stringify(requests)).toContain('data:image/jpeg;base64,')
    const saved = await backend.sessions.get(input.sessionId)
    const user = saved.messagePage.records.find(
      (record) => record.kind === 'user_input',
    )!
    expect(user.parts.map((part) => part.type)).toEqual(['image'])
    expect(JSON.stringify(saved)).not.toContain('base64,')
    await backend.dispose()
    backend = await openBackend()
    expect(await backend.runs.start(input)).toMatchObject({
      outcome: 'deduplicated',
    })
    expect(requests).toHaveLength(1)
    const other = await importImage()
    await expect(
      backend.runs.start({ ...input, attachmentIds: [other.id] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(
      await backend.attachments.preview(image.id, 'preview'),
    ).toBeInstanceOf(Buffer)
  })

  it('blocks unsupported models before any durable Session or message is created', async () => {
    const image = await importImage()
    await setImageSupport('unsupported')
    await expect(backend.runs.start(newInput(image))).rejects.toBeDefined()
    expect((await backend.bootstrap()).sessionPage.records).toHaveLength(0)
    expect(requests).toHaveLength(0)
    expect(backend.attachments.getMany(projectId, [image.id])).toEqual([image])
  })

  it('materializes ordinary files for tools and preserves images across retry and fork', async () => {
    const image = await importImage()
    const source = path.join(root, 'notes.txt')
    await writeFile(source, 'original local attachment')
    const file = await backend.attachments.importLocalFile(
      { projectId, draftKey: 'new' },
      source,
    )
    await rm(source)
    const input = {
      ...newInput(image),
      message: 'Read the notes',
      attachmentIds: [image.id, file.id],
    }
    await start(input)
    const native = JSON.stringify(requests[0]).match(
      /Read with local tools: ([^}]+)\}/u,
    )
    expect(native).not.toBeNull()
    const messages = requests[0].messages as { content?: unknown }[]
    const text = messages
      .flatMap((message) =>
        Array.isArray(message.content)
          ? (message.content as { type: string; text?: string }[])
          : [],
      )
      .find((block) => block.text?.startsWith('Attached file'))!.text!
    const filePath = JSON.parse(
      text.split('Read with local tools: ')[1],
    ) as string
    expect(await readFile(filePath, 'utf8')).toBe('original local attachment')
    const saved = await backend.sessions.get(input.sessionId)
    const user = saved.messagePage.records.find(
      (record) => record.kind === 'user_input',
    )!
    const forkId = 'session:fork' as SessionId
    await backend.sessions.fork({
      sourceSessionId: input.sessionId,
      expectedRevision: saved.session.revision,
      sessionId: forkId,
      throughMessageId: user.id,
    })
    const retry = await backend.runs.retry({
      version: 1,
      sessionId: input.sessionId,
      expectedRevision: saved.session.revision,
      userMessageId: user.id,
      clientRequestId: 'request:retry',
    })
    await backend.runtime.services.sessions.waitForRunSettled(
      input.sessionId,
      retry.runId,
    )
    expect(JSON.stringify(requests[1])).toContain('data:image/jpeg;base64,')
    const refreshed = await backend.sessions.get(input.sessionId)
    await backend.sessions.archive({
      sessionId: input.sessionId,
      expectedRevision: refreshed.session.revision,
    })
    expect(
      (await backend.sessions.get(forkId)).messagePage.records.some((record) =>
        record.parts.some((part) => part.type === 'image'),
      ),
    ).toBe(true)
    const fork = await backend.sessions.get(forkId)
    const archived = await backend.sessions.archive({
      sessionId: forkId,
      expectedRevision: fork.session.revision,
    })
    await backend.sessions.deleteArchived({
      sessionId: forkId,
      expectedRevision: archived.commit.change.session.revision,
    })
    expect(
      await backend.attachments.preview(image.id, 'preview'),
    ).toBeInstanceOf(Buffer)
  })

  it('uses real image content during synthetic compaction and retains originals in visible history', async () => {
    const image = await importImage()
    const input = newInput(image)
    await start(input)
    await start({
      version: 1,
      kind: 'existing_session',
      sessionId: input.sessionId,
      message: '/compact',
      clientRequestId: 'request:compact',
    })
    expect(JSON.stringify(requests[1])).toContain('data:image/jpeg;base64,')
    const saved = await backend.sessions.loadRuntimeState(input.sessionId)
    expect(
      saved.activeHistory.some((record) => record.kind === 'compact_summary'),
    ).toBe(true)
    expect(
      saved.activeHistory.some((record) =>
        record.parts.some((part) => part.type === 'image'),
      ),
    ).toBe(false)
    expect(
      (await backend.sessions.get(input.sessionId)).messagePage.records.some(
        (record) => record.parts.some((part) => part.type === 'image'),
      ),
    ).toBe(true)
  })

  it('keeps compression on the main vision model when the approval auxiliary is text-only', async () => {
    const image = await importImage()
    const input = newInput(image)
    await start(input)
    await store.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'deepseek',
      baseURL: 'https://example.test/v1',
      model: 'vision-test',
      enabledModelIds: ['vision-test', 'text-only'],
      modelOverrides: {
        'vision-test': { imageInput: 'supported' },
        'text-only': { imageInput: 'unsupported' },
      },
    })
    const config = store.getPublicConfig().models
    await store.update({
      version: 1,
      kind: 'models',
      value: {
        defaultModelProvider: config.defaultModelProvider,
        defaultModel: config.defaultModel,
        defaultModelReasoning: config.defaultModelReasoning,
        auxiliaryModelProvider: 'deepseek',
        auxiliaryModel: 'text-only',
        auxiliaryModelReasoning: 'off',
      },
    })
    const result = await backend.runs
      .start({
        version: 1,
        kind: 'existing_session',
        sessionId: input.sessionId,
        message: '/compact',
        clientRequestId: 'request:unsupported-compressor',
      })
      .catch(() => undefined)
    if (result?.outcome === 'started')
      await backend.runtime.services.sessions.waitForRunSettled(
        input.sessionId,
        result.runId,
      )
    expect(requests).toHaveLength(2)
    expect(requests[1].model).toBe('vision-test')
    expect(JSON.stringify(requests[1])).toContain('data:image/jpeg;base64,')
    const state = await backend.sessions.loadRuntimeState(input.sessionId)
    expect(
      state.activeHistory.some((record) => record.kind === 'compact_summary'),
    ).toBe(true)
  })

  it('preserves image history when compression fails and when switching the model route', async () => {
    const image = await importImage()
    const input = newInput(image)
    await start(input)
    failCompression = true
    await start({
      version: 1,
      kind: 'existing_session',
      sessionId: input.sessionId,
      message: '/compact',
      clientRequestId: 'request:bad-compact',
    })
    expect(
      (
        await backend.sessions.loadRuntimeState(input.sessionId)
      ).activeHistory.some((record) =>
        record.parts.some((part) => part.type === 'image'),
      ),
    ).toBe(true)
    failCompression = false
    await store.update({
      version: 1,
      kind: 'provider-settings',
      providerId: 'deepseek',
      baseURL: 'https://example.test/v2',
      model: 'vision-test',
    })
    await start({
      version: 1,
      kind: 'existing_session',
      sessionId: input.sessionId,
      message: 'Look again',
      clientRequestId: 'request:new-route',
    })
    expect(JSON.stringify(requests.at(-1))).toContain('data:image/jpeg;base64,')
    expect(
      (
        await backend.sessions.loadRuntimeState(input.sessionId)
      ).activeHistory.some(
        (record) => record.kind === 'conversation_transcript',
      ),
    ).toBe(true)
  })

  it('compacts previous images before adding a new round that exceeds the image request budget', async () => {
    const pixels = Buffer.alloc(2048 * 2048 * 3)
    let seed = 123456789
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      pixels[index] = seed & 255
    }
    const source = path.join(root, 'noise.png')
    await sharp(pixels, { raw: { width: 2048, height: 2048, channels: 3 } })
      .png()
      .toFile(source)
    const first: Attachment[] = []
    const next: Attachment[] = []
    for (let index = 0; index < 12; index++) {
      const asset = await backend.attachments.importLocalFile(
        { projectId, draftKey: index < 8 ? 'first' : 'next' },
        source,
      )
      ;(index < 8 ? first : next).push(asset)
    }
    const input = {
      ...newInput(first[0]),
      attachmentIds: first.map((image) => image.id),
    }
    await start(input)
    const currentBytes = [...first, ...next].reduce(
      (sum, asset) => sum + (asset.kind === 'image' ? asset.requestBytes : 0),
      0,
    )
    expect(currentBytes).toBeGreaterThan(16 * 1024 * 1024)
    await start({
      version: 1,
      kind: 'existing_session',
      sessionId: input.sessionId,
      message: 'New images',
      attachmentIds: next.map((asset) => asset.id),
      clientRequestId: 'request:next-images',
    })
    expect(requests).toHaveLength(3)
    expect(Object.hasOwn(requests[1], 'tools')).toBe(false)
    const active = (await backend.sessions.loadRuntimeState(input.sessionId))
      .activeHistory
    expect(
      active.flatMap((record) =>
        record.parts.flatMap((part) =>
          part.type === 'image' ? [part.attachment.id] : [],
        ),
      ),
    ).toEqual(next.map((asset) => asset.id))
    expect(active.some((record) => record.kind === 'compact_summary')).toBe(
      true,
    )
  }, 30_000)
})
