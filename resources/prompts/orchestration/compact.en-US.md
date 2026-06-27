Create a traceable compact summary that will replace the older conversation history.

Requirements:
- Preserve the user goal, key decisions, tools run, file changes, unfinished work, and risks.
- This summary will be reinjected as a `<compact_history>` user message and replace the old provider messages; do not assume the old history remains visible.
- Output only the summary body. Do not call tools or claim that files changed.
- Mark uncertain information instead of presenting inference as fact.
- Output structured Markdown that can be used to continue the conversation.
