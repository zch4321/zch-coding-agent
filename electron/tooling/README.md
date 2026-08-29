# Tooling

`electron/tooling` owns the process-local framework used to declare, register,
validate, execute, and project Tools. It contains no built-in Tool schemas or
business services.

The dependency direction is:

```text
electron/tools/* -> electron/tooling/*
electron/session/* -> electron/tooling/*
electron/tooling/* -X-> electron/tools/*
```

## Responsibilities

- `contracts.ts`: Tool definitions, calls, execution context, results, effects,
  and output policies.
- `registry.ts`: unique registration, compiled input validation, Provider-facing
  schemas, and provider-only intent metadata.
- `executor.ts`: approval revalidation, timeout/abort behavior, handler failure
  normalization, and non-abortable settlement tracking.
- `input-normalizer.ts`: conservative schema-guided repair of model-produced
  arguments.
- `result-builders.ts`: constructors for internal Tool results.
- `result-projection.ts`: deterministic conversion from internal results to
  canonical model-visible parts.
- `output-budget.ts`: global byte/token safety applied after per-Tool projection.

## Non-responsibilities

- Built-in schemas, descriptions, and handlers remain in `electron/tools`.
- Permission policy remains in `electron/permission`.
- Subagent and Swarm lifecycle belongs to a future `electron/agent-execution`
  package; their Tool definitions will remain thin adapters.
- Generic abort/deadline and filesystem transaction primitives belong to
  platform infrastructure rather than Tooling.

The former core files under `electron/tools` are compatibility facades. They
allow existing business modules to keep their current imports while Tooling is
reviewed and adopted incrementally.
