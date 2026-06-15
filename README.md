# My Coding Agent

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
