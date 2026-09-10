export interface MarkdownHighlightRequest {
  id: number
  source: string
  language: string
}

export interface MarkdownHighlightResponse {
  id: number
  html?: string
  error?: string
}
