# Repository Guidelines

## Structure and Boundaries

This is an Electron + Vue 3 desktop coding agent. Preserve process boundaries:

- `electron/`: privileged main process, preload bridge, runtime, tools, IPC, configuration, logging, and terminals.
- `src/`: sandboxed Vue renderer, Pinia state, and UI.
- `shared/`: process-neutral contracts and schemas; never import Electron, Node.js, or Vue here.
- `e2e/`: Playwright tests. `scripts/`: native and live-provider runners. `docs/`: architecture source of truth.

Define cross-process payloads once in `shared/` and validate them at IPC boundaries. Keep credentials out of the renderer, traces, logs, and child-process environments. Preserve sender validation, workspace path guards, bounded output, approval checks, and abort handling.

## Working Practices

- Never commit product code, tests, configuration, build scripts, or version bumps directly to `master`. Use the current non-`master` task branch when it is appropriate; create a branch only when working from `master` or no suitable task branch exists. New branches must use a conventional prefix such as `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, or `chore/`; never use the `codex/` prefix.
- Documentation-only changes may be committed directly to `master` when the user explicitly requests them. Mixed documentation and non-documentation changes must still use a non-`master` task branch.
- After making changes on a non-`master` branch, commit the scoped changes and push the branch to its configured remote.
- Keep each code file below 1,000 lines where practical, including test files, stylesheets, Vue components, and pages. Exceed this only when the functionality is genuinely cohesive or splitting it would add more complexity than it removes.
- Use TypeScript and Vue SFCs. Prettier enforces two spaces, single quotes, no semicolons, and trailing commas; ESLint handles semantic rules. Use `kebab-case.ts` modules, `PascalCase.vue` components, `camelCase` values, and `PascalCase` types.
- Prefer Naive UI components for renderer UI. Before implementing or changing frontend behavior, consult the [Naive UI documentation](https://www.naiveui.com/zh-CN/os-theme/docs/introduction) for an existing component or supported composition, and reuse it where practical instead of building custom controls or writing custom CSS.
- Document every class and public method or function with a concise comment explaining its responsibility.
- Keep commits cohesive and use imperative Conventional Commit-style subjects.
- Do not delegate implementation work to coder subagents unless the user explicitly asks. Read-only exploration and review tasks may use explore/swarm subagents.

## Verification

- Before `npm run check`, format the files changed by the task. Use `npm run format` when the worktree contains no unrelated user edits; otherwise run Prettier in write mode only on task-owned files so formatting does not modify unrelated work.
- `npm run check` is the routine developer gate. It runs lint, formatting, deterministic Vitest tests, and typecheck in parallel, waits for every sibling check, and reports all failures together.
- `npm run verify` is the complete merge and release gate. It adds runtime smoke tests, app/headless builds, Windows packaging, packaged SQLite smoke, and Playwright against the built app. Run it before merging or releasing, or when the user explicitly requests the full gate; do not run it after every ordinary edit.
- Do not repeat commands already included by the selected gate unless isolating a failure. `npm run test:runtime` groups native PTY, ripgrep, and development SQLite checks while keeping them in separate child processes for ABI and binary diagnostics.
- `npm run test:e2e` remains an independent convenience entry that builds the app before Playwright. `npm run build` automatically runs `test:runtime` and, after Windows packaging, the packaged SQLite-only probe.
- Do not run `test:real` unless the user explicitly requests that workload. It requires credentials and paid Provider usage and is not part of `npm run verify`.

Add regression coverage for changed policy, parser, IPC, and tool behavior. Exercise security-sensitive branches.

## Prompt Harness and Context

Keep base instructions stable and document model-visible harness tags there. Tagged user-role messages are harness-injected context, not user-authored chat messages, except explicit live user interjections.

Do not modify session history except through explicit compaction. Runtime context, AGENTS changes, interjections, selected context, and tool results append new messages or layers; provider context selection may omit old messages, but stored history remains append-only. Prompt resources and templates must be deterministic, versioned, and validated for unresolved variables; never add executable template logic or put repository, user, or tool context into system-level instructions.
