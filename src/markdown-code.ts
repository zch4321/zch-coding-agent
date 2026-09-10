import type {
  MarkdownHighlightRequest,
  MarkdownHighlightResponse,
} from './markdown-highlight-protocol'

const MAX_CACHE_BYTES = 8 * 1024 * 1024
const MAX_CACHE_ENTRIES = 128
const cache = new Map<string, string>()
let cacheBytes = 0
let worker: Worker | undefined
let nextId = 0
const pending = new Map<
  number,
  { resolve(html: string): void; reject(error: Error): void }
>()
const inFlight = new Map<string, Promise<string>>()

/** Resolves supported syntax aliases to the grammars bundled with the application. */
export function normalizeCodeLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'ts':
    case 'tsx':
    case 'typescript':
      return 'typescript'
    case 'js':
    case 'jsx':
    case 'javascript':
      return 'javascript'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'sh':
    case 'shell':
    case 'bash':
    case 'powershell':
    case 'ps1':
    case 'shellscript':
      return 'shellscript'
    case 'json':
      return 'json'
    default:
      return 'text'
  }
}

/** Escapes unhighlighted code for immediate display while a fence is still streaming. */
export function plainCodeHtml(code: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  return `<pre class="shiki"><code>${escape(code)}</code></pre>`
}

function cacheKey(source: string, language: string): string {
  return `github-light\0${normalizeCodeLanguage(language)}\0${source}`
}

/** Returns previously highlighted code without scheduling work or flashing a plain preview. */
export function cachedCodeHtml(
  source: string,
  language: string,
): string | undefined {
  const key = cacheKey(source, language)
  const html = cache.get(key)
  if (html !== undefined) {
    cache.delete(key)
    cache.set(key, html)
  }
  return html
}

function remember(key: string, html: string): void {
  const bytes = (key.length + html.length) * 2
  if (bytes > MAX_CACHE_BYTES) return
  const existing = cache.get(key)
  if (existing !== undefined) cacheBytes -= (key.length + existing.length) * 2
  cache.delete(key)
  cache.set(key, html)
  cacheBytes += bytes
  while (cacheBytes > MAX_CACHE_BYTES || cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.entries().next().value
    if (!oldest) break
    cacheBytes -= (oldest[0].length + oldest[1].length) * 2
    cache.delete(oldest[0])
  }
}

function getWorker(): Worker {
  if (worker) return worker
  const created = new Worker(
    new URL('./markdown-highlight-worker.ts', import.meta.url),
    { type: 'module' },
  )
  created.onmessage = (event: MessageEvent<MarkdownHighlightResponse>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    if (typeof event.data.html === 'string') request.resolve(event.data.html)
    else
      request.reject(new Error(event.data.error ?? 'Code highlighting failed'))
  }
  created.onerror = () => {
    if (worker !== created) return
    worker = undefined
    created.terminate()
    for (const request of pending.values())
      request.reject(new Error('Code highlighting worker failed'))
    pending.clear()
  }
  worker = created
  return created
}

/** Highlights code off the UI thread, sharing requests and retaining a bounded result cache. */
export function renderCode(
  source: string,
  requestedLanguage: string,
): Promise<string> {
  const language = normalizeCodeLanguage(requestedLanguage)
  if (language === 'text') return Promise.resolve(plainCodeHtml(source))
  const cached = cachedCodeHtml(source, language)
  if (cached !== undefined) return Promise.resolve(cached)
  const key = cacheKey(source, language)
  const existing = inFlight.get(key)
  if (existing) return existing
  const request = new Promise<string>((resolve, reject) => {
    const target = getWorker()
    const id = ++nextId
    pending.set(id, { resolve, reject })
    try {
      target.postMessage({
        id,
        source,
        language,
      } satisfies MarkdownHighlightRequest)
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
    .then((html) => {
      remember(key, html)
      return html
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, request)
  return request
}
