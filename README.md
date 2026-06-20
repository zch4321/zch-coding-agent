# My Coding Agent

## Provider credential

Production credentials are stored through Electron `safeStorage`. For local
development and opt-in live tests, `DEEPSEEK_API_KEY` is accepted as a
main-process-only fallback when no stored credential exists. It is not exposed
to the renderer, trace files, or child-process environments.

Optional live-test overrides are `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL`.
Run the real endpoint suite explicitly:

```powershell
$env:DEEPSEEK_API_KEY = '...'
npm run test:real
```

The command fails immediately when the key is missing. Normal `npm test` skips
the live suite and remains deterministic.

Electron + Vue desktop coding agent. The implementation follows the staged plan in
[`docs/implementation-plan.md`](./docs/implementation-plan.md).

## Development

```sh
npm ci
npm run dev
```

## P0 quality gates

```sh
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:e2e
npm run build
```
