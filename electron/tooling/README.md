# Tooling framework

`electron/tooling` owns Tool definitions, registration, input validation, execution and result projection. Built-in Tool schemas and handlers live in `electron/tools`; lifecycle services remain in `electron/subagent`, `electron/swarm` and `electron/background`.

Read the [Tools and permissions code map](../../docs/code-map/tools-and-permissions.md) for entry points, call flow and tests, and the [architecture boundary](../../docs/architecture/boundaries.md) for dependency rules. Existing imports under `electron/tools` may be compatibility facades; new framework implementation belongs here.
