# Repository Guidelines

## Project Structure & Module Organization

This is an Electron + Vue 3 desktop coding agent. Preserve process boundaries:

- `electron/` contains the privileged main process, preload bridge, agent runtime, tools, IPC, configuration, logging, and terminals.
- `src/` contains the sandboxed Vue renderer, Pinia state, and UI components.
- `shared/` contains process-neutral contracts and schemas; do not import Electron, Node.js, or Vue here.
- `e2e/` holds Playwright tests; `scripts/` holds native and live-provider runners.
- `docs/` is the architecture source of truth. `designs/` and `public/` contain visual references and static assets.

## Build, Test, and Development Commands

- `npm ci`: install locked dependencies.
- `npm run dev`: start Vite and Electron for local development.
- `npm run build`: run checks, native smoke tests, and produce a Windows x64 package.
- `npm test`: run deterministic Vitest tests.
- `npm run test:e2e`: build and run Playwright serially.
- `npm run test:native`: verify `node-pty` integration.
- `npm run test:real`: run opt-in DeepSeek tests; requires `DEEPSEEK_API_KEY`.
- `npm run lint`, `npm run format:check`, `npm run typecheck`: required static quality gates.

## Coding Style & Naming Conventions

Use TypeScript and Vue Single-File Components. Prettier enforces two-space indentation, single quotes, no semicolons, and trailing commas; ESLint handles semantic rules. Use `kebab-case.ts` for modules, `PascalCase.vue` for components, `camelCase` for values, and `PascalCase` for types. Define cross-process payloads once in `shared/` and validate them at IPC boundaries.

## Testing Guidelines

Vitest tests are colocated as `*.test.ts`; Playwright specs use `e2e/*.spec.ts`. Add regression coverage for changed policies, parsers, IPC handlers, and tools. Security-sensitive branches must be exercised. Keep `npm test` offline and deterministic; never fold live API tests into it.

## Commit & Pull Request Guidelines

History uses concise Conventional Commit-style subjects, for example `feat: complete P4 terminal and context safeguards`. Use an imperative subject and coherent commits. Pull requests should explain behavior and security impact, link issues, list commands run, and include screenshots for renderer changes. Call out migrations, native changes, or required environment variables.

## Security & Configuration Tips

Never expose credentials to the renderer, traces, logs, or child-process environments. Production secrets belong in Electron `safeStorage`; `DEEPSEEK_API_KEY` is only a main-process development fallback. Preserve sender validation, workspace path guards, bounded output, approval checks, and abort handling when adding tools or IPC methods.
