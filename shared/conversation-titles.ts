/**
 * Shared conversation display/title constants.
 *
 * Kept process-neutral so the renderer and any future main-process titling
 * share the same bounds. The schema allows up to 256 chars, but the UI caps
 * editable/auto titles at {@link CONVERSATION_TITLE_MAX} for readability.
 */
export const CONVERSATION_TITLE_MAX = 120
export const CONVERSATION_TITLE_AUTO_SLICE = 56
export const DEFAULT_CONVERSATION_TITLE = 'New conversation'
export const FORK_TITLE_PREFIX = 'Fork'

/**
 * Collapse whitespace, trim, and slice a raw auto-title candidate.
 */
export function deriveAutoTitle(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CONVERSATION_TITLE_AUTO_SLICE)
}

/**
 * Normalize a user-supplied title before persisting.
 */
export function normalizeTitle(title: string): string {
  return title.trim().slice(0, CONVERSATION_TITLE_MAX)
}
