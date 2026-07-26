const LIVE_INTERJECTION_RULE_NOTE =
  'Messages tagged as <live_user_interjection> are real user messages received while the current run was already in progress. They are not tool output. Treat them as the latest user instruction for the next reasoning step, while respecting system, developer, runtime, repository, and tool-safety instructions.'

/** Wraps user interjection content in the markers consumed by prompt construction. */
export function renderLiveUserInterjection(content: string): string {
  return [
    '<live_user_interjection>',
    content,
    '</live_user_interjection>',
    '',
    LIVE_INTERJECTION_RULE_NOTE,
  ].join('\n')
}
