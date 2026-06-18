import MarkdownIt from 'markdown-it'

interface FenceBlock {
  marker: string
  code: string
  language: string
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})
const supportedLanguages = new Set([
  'typescript',
  'javascript',
  'json',
  'markdown',
  'shellscript',
])
type MarkdownHighlighter = {
  codeToHtml(code: string, options: { lang: string; theme: string }): string
}
let highlighterPromise: Promise<MarkdownHighlighter> | undefined

markdown.validateLink = (url) => {
  const normalized = url.trim().toLowerCase()
  return (
    normalized.startsWith('https://') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('mailto:') ||
    normalized.startsWith('#')
  )
}

markdown.renderer.rules.fence = (tokens, index, _options, env) => {
  const fences = env.fences as FenceBlock[]
  const token = tokens[index]
  const language = token.info.trim().split(/\s+/)[0] || 'text'
  const marker = `@@SHIKI_FENCE_${fences.length}@@`
  fences.push({ marker, code: token.content, language })
  return marker
}

markdown.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  const token = tokens[index]
  const hrefIndex = token.attrIndex('href')

  if (hrefIndex >= 0) {
    token.attrSet('rel', 'noreferrer noopener')
    token.attrSet('target', '_blank')
  }

  return self.renderToken(tokens, index, options)
}

function normalizeLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'md':
      return 'markdown'
    case 'sh':
    case 'shell':
    case 'bash':
    case 'powershell':
    case 'ps1':
      return 'shellscript'
    default:
      return supportedLanguages.has(language) ? language : 'text'
  }
}

function plainCodeHtml(code: string): string {
  return `<pre class="shiki"><code>${markdown.utils.escapeHtml(code)}</code></pre>`
}

function getHighlighter(): Promise<MarkdownHighlighter> {
  highlighterPromise ??= Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
    import('shiki/themes/github-light.mjs'),
    import('shiki/langs/javascript.mjs'),
    import('shiki/langs/json.mjs'),
    import('shiki/langs/markdown.mjs'),
    import('shiki/langs/shellscript.mjs'),
    import('shiki/langs/typescript.mjs'),
  ]).then(
    ([
      core,
      engine,
      githubLight,
      javascript,
      json,
      markdownLanguage,
      shellscript,
      typescript,
    ]) =>
      core.createHighlighterCore({
        themes: [githubLight.default],
        langs: [
          typescript.default,
          javascript.default,
          json.default,
          markdownLanguage.default,
          shellscript.default,
        ],
        engine: engine.createJavaScriptRegexEngine(),
      }),
  )

  return highlighterPromise
}

export async function renderMarkdown(source: string): Promise<string> {
  const fences: FenceBlock[] = []
  let html = markdown.render(source, { fences })

  for (const fence of fences) {
    const language = normalizeLanguage(fence.language)
    const rendered =
      language === 'text'
        ? plainCodeHtml(fence.code)
        : (await getHighlighter()).codeToHtml(fence.code, {
            lang: language,
            theme: 'github-light',
          })

    html = html
      .replace(`<p>${fence.marker}</p>`, rendered)
      .replace(fence.marker, rendered)
  }

  return html
}
