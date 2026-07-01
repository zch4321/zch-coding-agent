Start and pursue this Goal: ${objective}

Use goal_get when you need the current state. Before ending the run, eventually converge to one of these outcomes:

1. If the objective has met verifiable completion criteria, call goal_complete and provide summary, evidence, and remainingRisks.
2. If progress cannot continue without user input or an external state change, call goal_block and provide reason and requiredInput.
