# Headless CLI

Headless 复用 Desktop 的 Backend 和 Agent loop，适合通过脚本提交任务并读取结构化结果。当前固定 Yolo，支持异步 Subagent/background tools，不提供 Swarm。规范见 [Agent execution 与宿主](../architecture/agent-execution.md)，代码见[宿主地图](../code-map/integrations-and-hosts.md)。

## 准备与运行

1. 安装依赖后运行 `npm run build:headless`。
2. 准备 UTF-8 任务文本和 JSON 配置，并在启动进程的环境中设置配置所引用的 Provider credential。
3. 选择实际存在的 workspace，以及位于 workspace 外的 artifacts 目录。运行示例中的目录和文件需要替换为自己的路径。

```json
{
  "schemaVersion": 5,
  "provider": {
    "id": "openai-compatible",
    "providerType": "generic.chat-completions",
    "baseURL": "https://provider.example/v1",
    "model": "coding-model",
    "reasoning": "high",
    "credentialEnv": "HEADLESS_PROVIDER_API_KEY"
  },
  "maxAutoPlanApprovals": 1
}
```

此配置只保存环境变量名称，不包含 API Key。完整可选字段和旧版本迁移见 [contracts.ts](../../electron/headless/contracts.ts) 与 [config.ts](../../electron/headless/config.ts)。

```powershell
npm run agent:headless -- run --workspace C:\work\demo --task-file C:\tasks\task.txt --config C:\tasks\config.json --artifacts C:\artifacts\run-001 --timeout-ms 600000
```

需要直接把 stdout 交给 JSONL 消费程序时，使用已构建入口，避免 npm 自身打印的 script banner：

```powershell
node dist-headless/zch-agent-headless.mjs run --workspace C:\work\demo --task-file C:\tasks\task.txt --config C:\tasks\config.json --artifacts C:\artifacts\run-001 --timeout-ms 600000
```

## 读取结果

- Host stdout 是版本化 JSONL，诊断写 stderr，运行日志与任务输出写入 artifacts。
- `result.json` 和 runtime identity 原子写入，包含终态、usage、工具统计及输出位置；具体字段从版本化契约读取。
- `completed` 只表示 Agent Run 正常结束，需要由调用方验收代码、测试或其他业务结果。
- Plan 自动批准在前一 Run 完整结束后追加 harness 消息；达到自动批准上限或 Goal blocked 时可能返回 `needs_human_input`。
- timeout、SIGINT/SIGTERM 进入共享中断与清理；退出时清理未等待的后台任务，已生成 artifact 由调用者管理。
- 不输出 workspace patch，不修改 Git index 来采集结果。Task 独立临时 SQLite 在退出时关闭并删除。

完整跨宿主 trajectory 对比尚有覆盖缺口，见[验证指南](./testing.md#已知验证缺口)。开发验证使用 [headless.test.ts](../../electron/headless/headless.test.ts) 的 scripted-provider 测试；不要为文档或常规验证启动真实付费任务。
