# P0 Baseline and Regression Gates

Recorded on 2026-07-22 for `refactor/backend-state-v2`.

## Required gates

| Command                | Result                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| `npm run lint`         | Passed                                                           |
| `npm run format:check` | Passed                                                           |
| `npm run typecheck`    | Passed                                                           |
| `npm test`             | 94 files passed, 2 skipped; 617 tests passed, 7 skipped; 57.34 s |
| `npm run test:native`  | Passed (`PTY_OK`, Electron 42.4.0)                               |
| `npm run test:ripgrep` | Passed (`RG_OK`)                                                 |
| `npm run test:e2e`     | 29 passed; 1.7 min                                               |

`benchmarks/cases/cases.test.ts` is excluded from the default Vitest suite.
It is not a P0, refactor, or release gate and must not be run as part of this
workstream.

## Provider trajectory goldens

| Trajectory                     | Fixture and regression test                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Normal text                    | `electron/providers/fixtures/deepseek-wire-goldens.ts` → `deepseek-provider.golden.test.ts`                      |
| Reasoning                      | Same wire fixture, including DeepSeek thinking parameters and reasoning projection                               |
| Single and multiple tool calls | Same wire fixture, including request tool sanitization, chunked arguments, call ordering and normalized intent   |
| User refusal                   | `session-manager.approval.test.ts` verifies the next Provider request contains the terminal `denied` tool result |
| Approval timeout               | Same approval test verifies the terminal successful tool result after explicit user approval                     |
| Compact                        | `session-manager.compaction.test.ts` verifies compact request shape and the post-compact request                 |
| Interjection                   | `session-manager.interjections.test.ts` verifies tool-batch ordering and injected context                        |
| Plan continuation              | `session-manager.orchestration.test.ts` verifies reviewed and active Plan continuation trajectories              |

## Electron/Headless parity

Desktop and Headless use the same runtime factory. Their parity is protected by
the shared runtime integration suites instead of a separate normalized snapshot
implementation.

## P7 preparation

[`backend-refactor-p7-checklist.md`](./backend-refactor-p7-checklist.md)
enumerates every current direct Workbench E2E fixture and renderer test stub
that P7/P9 must replace.
