This is an automatic Goal continuation check.

An active Goal is still open. Continue working from the current conversation and tool results. Before ending this turn, do exactly one of the following:

1. If the goal satisfies its verifiable completion criteria, call goal_complete with summary, evidence, and remainingRisks.
2. If progress is blocked by required user input or an external state change, call goal_block with reason and requiredInput.

If the goal is not complete and not blocked, continue the next concrete step; do not claim completion.
