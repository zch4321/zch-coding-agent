# P7 Legacy Workbench Replacement Checklist

P0 audit, 2026-07-22. These callers currently use `workbench:get` or
`workbench:save` directly and must move to durable backend commands or the
restricted target seed helper before P8 cutover.

## E2E fixtures and assertions

- `e2e/artifact-layout.spec.ts`: seeds and edits conversations through the
  Workbench snapshot in three scenarios.
- `e2e/features.chat-tools.spec.ts`: reads the persisted Workbench after a
  tool trajectory.
- `e2e/features.concurrency.spec.ts`: reads the Workbench to assert
  background-session state.
- `e2e/workbench-terminal.spec.ts`: seeds conversations and verifies reload
  state through the Workbench bridge.

## Renderer store tests

- `src/stores/agent.history.test.ts`
- `src/stores/agent.concurrency.test.ts`
- `src/stores/agent.facade-settings.test.ts`
- `src/stores/agent-test-support.ts`

These tests currently stub `AgentApi.saveWorkbench` or assert complete
Workbench snapshots. P7 replaces them with command-result/durable-event
reconciliation assertions. They must not retain a test-only durable
`workbench:save` backdoor.

## Cutover verification

- Replace E2E fixture writes with target Project/Session/Message commands or
  a backend-private seed helper that does not exist in the production preload
  API.
- Assert reload through `app:get-bootstrap`, `session:get` and paged messages.
- Remove `getWorkbench`, `saveWorkbench` and `migrateWorkbenchV1` from test
  stubs, `AgentApi`, preload and IPC contracts in P9.
