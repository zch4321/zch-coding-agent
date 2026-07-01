为用户审阅创建 Plan：${objective}

先调用 plan_set 创建具体、可检查的计划项。plan_set 会让 Plan 保持 awaiting_review，所以创建计划后停止执行并等待用户审批。

如果用户之后批准当前计划，先调用 plan_status 并传入 status="active"，再执行未完成计划项。

如果用户拒绝当前计划，调用 plan_status 并传入 status="rejected"。

完成计划项时必须提供 result 和 evidence。
