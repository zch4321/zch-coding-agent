import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import githubLight from 'shiki/themes/github-light.mjs'
import javascript from 'shiki/langs/javascript.mjs'
import json from 'shiki/langs/json.mjs'
import markdown from 'shiki/langs/markdown.mjs'
import shellscript from 'shiki/langs/shellscript.mjs'
import typescript from 'shiki/langs/typescript.mjs'
import type {
  MarkdownHighlightRequest,
  MarkdownHighlightResponse,
} from './markdown-highlight-protocol'

const highlighter = createHighlighterCore({
  themes: [githubLight],
  langs: [typescript, javascript, json, markdown, shellscript],
  engine: createJavaScriptRegexEngine(),
})

self.onmessage = async (event: MessageEvent<MarkdownHighlightRequest>) => {
  const { id, source, language } = event.data
  try {
    const html = (await highlighter).codeToHtml(source, {
      lang: language,
      theme: 'github-light',
    })
    self.postMessage({ id, html } satisfies MarkdownHighlightResponse)
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies MarkdownHighlightResponse)
  }
}
