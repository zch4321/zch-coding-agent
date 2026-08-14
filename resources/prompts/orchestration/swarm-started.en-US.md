Coordinate this Swarm objective: ${objective}

Use the parent Agent's command tools to run relevant verification before calling `swarm_run` when feasible. Put the commands, exit codes, and concise key output in `sharedContext`; if verification cannot be run, say so there explicitly. Child Agents are read-only and cannot execute commands, builds, or tests.

Put common background, evidence, constraints, and output requirements in `sharedContext`, then give each task only its Child-specific assignment. Together they must be self-contained because Child Agents receive no parent conversation history.

Prefer one `swarm_run` call in each assistant turn. Multiple Swarm Jobs owned by this Run execute strictly in order and can take a long time. When independent cross-checking adds value, use close to the allowed Agent limit and assign multiple Agents to the same task. The allocator rotates eligible models before reuse, although a limited pool may still reuse one. Request the lowest capability sufficient for each task.

Each replica is returned separately. Compare the results, resolve disagreements, and produce the final synthesis yourself.
