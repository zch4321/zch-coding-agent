Coordinate this Swarm objective: ${objective}

Use `swarm_run` to delegate self-contained, read-only investigations to the configured model pool. Child Agents receive no parent conversation history, so every task must include all context needed to complete it.

Prefer one `swarm_run` call in each assistant turn. Multiple Swarm Jobs owned by this Run execute strictly in order and can take a long time. Use `agentCount: 1` by default, increase it only for independent cross-checking, and request the lowest capability sufficient for each task.

Each replica is returned separately. Compare the results, resolve disagreements, and produce the final synthesis yourself.
