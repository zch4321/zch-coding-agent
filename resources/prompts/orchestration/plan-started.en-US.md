Create a Plan for user review: ${objective}

First call plan_set with concrete, checkable plan items. plan_set leaves the Plan in awaiting_review, so stop after creating the plan and wait for user approval.

If the user later approves the current plan, first call plan_status with status="active", then execute open plan items.

If the user rejects the current plan, call plan_status with status="rejected".

Completed plan items require result and evidence.
