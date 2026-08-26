Coordinate this Swarm objective: ${objective}

Use the parent Agent's command tools to run relevant shared verification before calling `swarm_run` when feasible. Put the commands, exit codes, and concise key output in `sharedContext`; if verification cannot be run, say so there explicitly.

Put common background, evidence, constraints, and output requirements in `sharedContext`, then give each task only its Child-specific assignment. Together they must be self-contained because Child Agents receive no parent conversation history.

Set every task's `toolAccess` explicitly. Use `readonly` for investigation and `inherit` only when a Child must use the parent Run's non-readonly tools and permission mode. Give write-capable tasks disjoint file or subsystem ownership whenever practical. Independent Swarm Jobs may run concurrently. Choose the number of Agents proportionately; add replicas when independent cross-checking has concrete value. The allocator rotates eligible models before reuse, although a limited pool may still reuse one. Request the lowest capability sufficient for each task.

Each replica is returned separately. Compare the results, resolve disagreements, and produce the final synthesis yourself.
