# Frontend Refactor Plan

> Status: core fixes verified; decomposition continues · Started 2026-06-20 · Updated 2026-06-20

## Verified Outcome

- Approval payloads omit optional `undefined` fields, decisions are idempotent,
  and errors remain visible outside the scrolling history.
- Provider settings use one atomic IPC request with isolated drafts and explicit
  saving, dirty, success, and failure states.
- New traces omit stream chunks while retaining final responses and replay
  compatibility.
- `App.vue` is reduced from about 1,700 lines to about 300 lines. Layout,
  projects, chat, artifacts, settings, and dialogs now live in domain
  components; skills, traces, and shared Agent types use separate stores/files.
- Lint, formatting, type checks, 225 unit/integration tests, 10 Electron E2E
  tests, and the native PTY smoke test pass. The real-provider suite remains
  opt-in because the verification shell has no `DEEPSEEK_API_KEY`.

## Goals

- Fix approval submission failures, duplicate decisions, and lost Diff state.
- Stop writing per-chunk `llm.stream` trace records while retaining all other trace evidence and legacy replay compatibility.
- Prevent settings responses from overwriting unsaved form drafts.
- Split the oversized `App.vue`, `stores/agent.ts`, and global stylesheet into reviewable domain modules.
- Complete the remaining requirements in `frontend-spec.md` with deterministic tests.

## Execution Order

### 1. Characterization Tests

- Add a programmable renderer API fixture.
- Cover approval idempotency, stale decisions, Diff retention, settings save snapshots, and event ordering.
- Keep real-provider testing opt-in; deterministic tests remain the default gate.

### 2. Approval State Machine

- Represent approvals as `requested → submitting → allowed | denied | stale | expired | failed`.
- Share one record between the conversation card and Diff footer.
- Disable both decision surfaces immediately after the first click.
- Treat a rejected runtime decision as an explicit error instead of clearing UI state.
- Retain the latest reviewed Diff and result after resolution.

### 3. Trace Compaction

- Do not emit new `llm.stream` records.
- Retain request, final response, usage, timing, run, tool, approval, and error events.
- Continue reading historical traces containing stream events.
- Reconstruct new-trace replay from `llm.response.normalizedTurn`.

### 4. Transactional Settings Drafts

- Separate canonical configuration from editable form drafts.
- Capture an immutable save snapshot and reconcile only after all writes complete.
- Add saving, dirty, success, and failure states without discarding user input.
- Persist the default permission mode through a versioned configuration migration.

### 5. Store Decomposition

Split state into `config`, `workbench`, `runtime`, `approvals`, `artifacts`, `skills`, and `traces` domains. Introduce a typed Agent API client so components do not repeat bridge/error handling. Store timeline and Artifact state per conversation.

### 6. Component Decomposition

Reduce `App.vue` to initialization and composition. Extract layout, project sidebar, conversation timeline, composer, tool/approval cards, Artifact views, settings panels, and dialogs. Move component styling beside each component; retain only tokens and shell layout globally.

### 7. Frontend Requirement Completion

- Preserve chronological message/tool/approval/error order.
- Add Agent event sequence de-duplication and gap reporting.
- Add stream-follow pause and “Back to bottom”.
- Add bounded syntax highlighting to file preview.
- Add draggable Terminal height with a 160px minimum.
- Add an editable model combobox in the composer.
- Complete grouped search results, responsive layouts, ARIA tab semantics, and focus restoration.

### 8. Verification

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run test:native`. Run `npm run test:real` only when `DEEPSEEK_API_KEY` is available. Update architecture and frontend acceptance documentation only after verified behavior lands.

## Review and Commit Strategy

Keep each phase independently buildable and reviewable: characterization tests, approval fix, trace compaction, settings fix, store extraction, component extraction, and requirement completion. Avoid mixing mechanical moves with behavior changes in the same commit.
