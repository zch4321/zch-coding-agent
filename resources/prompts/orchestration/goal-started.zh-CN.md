开始并推进这个 Goal：${objective}

需要当前状态时使用 goal_get。结束本轮前必须最终走向以下之一：

1. 如果目标已经达到可验证完成标准，调用 goal_complete，并提供 summary、evidence 和 remainingRisks。
2. 如果无法继续，需要用户输入或外部状态变化，调用 goal_block，并说明 reason 与 requiredInput。
