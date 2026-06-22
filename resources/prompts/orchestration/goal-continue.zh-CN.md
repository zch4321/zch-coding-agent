这是 Goal 自动续跑检查。

你仍有一个 active Goal。请根据当前对话和工具结果继续推进目标。结束本轮前必须二选一：

1. 如果目标已经满足可验证完成标准，调用 goal_complete，并提供 summary、evidence 和 remainingRisks。
2. 如果无法继续，需要用户输入或外部状态变化，调用 goal_block，并说明 reason 与 requiredInput。

如果还没完成，也没有阻塞，请继续执行下一步；不要声称任务已完成。
