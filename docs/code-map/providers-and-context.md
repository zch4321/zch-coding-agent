# Provider、历史与 Prompt Context

返回[总地图](./README.md)。规范见 [Provider 与 Context](../architecture/providers-and-context.md)。

## 职责与边界

Session Core 操作 canonical history，ModelProvider 编译和解释具体 wire 协议。稳定指令是版本化资源；AGENTS、运行状态、用户选中内容和工具结果通过可审计层进入历史，不注入 system 指令模板。

项目路径协议由双语 `harness/base-instructions` 解释原生短路径、产物目录布局、文件/目录读取和 Shell 变量规则；`harness/runtime-context` 声明 `native_absolute` 并提供运行时实际路径。资源版本在 `shared/prompt-resources.ts` 登记，静态规则和动态地址的分层由 `prompt-harness.test.ts` 覆盖。

## 关键入口

| 文件 / 符号                                                                                                                                                          | 责任                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [provider.ts](../../electron/providers/provider.ts) / `ModelProvider`                                                                                                | compile/stream/compact 的扁平协议边界       |
| [provider-factory.ts](../../electron/providers/provider-factory.ts)                                                                                                  | providerType 选择具体实现                   |
| [model-route-resolver.ts](../../electron/providers/model-route-resolver.ts)                                                                                          | 冻结 route、profile 与 credential binding   |
| [model-catalog.ts](../../electron/providers/model-catalog.ts)、[usage.ts](../../electron/providers/usage.ts)                                                         | 模型能力与标准化用量                        |
| [canonical-history.ts](../../electron/session/canonical-history.ts)                                                                                                  | 有序 records、call/result 配对与历史编译    |
| [prompt-harness.ts](../../electron/session/prompt-harness.ts)、[session-prompt-context-coordinator.ts](../../electron/session/session-prompt-context-coordinator.ts) | 稳定 harness 和上下文变更追加               |
| [prompts/registry.ts](../../electron/prompts/registry.ts)、[resources/prompts](../../resources/prompts/)                                                             | 确定性模板装配与中英文资源                  |
| [context-ingress.ts](../../electron/session/context-ingress.ts)、[context-attachments.ts](../../electron/session/context-attachments.ts)                             | 内容进入 Provider 前的检查与附件边界        |
| [session-compact-coordinator.ts](../../electron/session/session-compact-coordinator.ts)                                                                              | Provider usage 触发压缩、epoch 和 retry     |
| [conversation-transcript.ts](../../electron/session/conversation-transcript.ts)                                                                                      | 跨 route 的字面历史转换与 Conversation 导出 |
| [session-provider-retry.ts](../../electron/session/session-provider-retry.ts)                                                                                        | Provider attempt retry 的分类与等待         |

## 主要调用链

```text
Session selection → frozen ResolvedModelRoute
  → canonical records + prompt layers → MessageHistoryCompiler
  → ModelProvider.compile → transport/stream → canonical completion
  → 完整 assistant/tool records → usage-driven compact 或下一轮
```

各实现位于 [providers](../../electron/providers/)；共享 SSE 传输在 [http-sse-transport.ts](../../electron/providers/http-sse-transport.ts)，通用 HTTP 和网络边界在 [net](../../electron/net/)。

Chat Completions、Responses、Anthropic 共用 [provider-shared.ts](../../electron/providers/provider-shared.ts) 的 JSON、Intent、指标及文本边界原语。`ProviderArgumentsAccumulator` 按新 delta 累计 UTF-8 大小并保留跨块代理对状态，避免重复扫描累计参数；各协议仍分别处理终态 JSON、continuation 与 thinking。字节工作量与边界回归见 [provider-arguments.test.ts](../../electron/providers/provider-arguments.test.ts)。

## 状态与契约

[MessageRecord](../../shared/message.ts) 保留有序 parts、可读 reasoning 和 opaque continuation；Renderer 只展示允许的投影。Provider DTO 不进入 shared 或 Repository。压缩影响 active history 的选择，旧完整消息仍保留。配置热变更不得替换已冻结 Run 的 route。

## 修改指引

- 新增 Provider：实现 ModelProvider、factory 和 [providers config](../../shared/config/providers.ts)，检查 route/profile、reasoning、usage、tool schema 与 continuation；迁移不能破坏历史协议身份。
- 修改 Prompt：同时检查 [prompt-resources.ts](../../shared/prompt-resources.ts)、资源版本和中英文模板，验证未知变量、稳定层、标签和指纹；Prompt 文件不属于普通文档格式化范围。
- 修改压缩/重试：覆盖 usage 缺失、Provider 已接受响应、工具 batch 尚未完成、取消、失败和 route 转换；本地估算不是拒绝 Provider 请求的依据。
- 修改 token 展示：从 usage 到 [ConversationHeader.vue](../../src/components/chat/ConversationHeader.vue) 追踪，区分最近上下文与累计明细；未定口径见[开放问题](../open-design-questions.md)。

## 验证入口

| 测试                                                                                                                                                                                       | 验证内容                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| [canonical-history.test.ts](../../electron/session/canonical-history.test.ts)                                                                                                              | 顺序、配对、非法历史和 continuation    |
| [prompt-harness.test.ts](../../electron/session/prompt-harness.test.ts)                                                                                                                    | 稳定资源、变量、标签与上下文追加       |
| [session-manager.compaction.test.ts](../../electron/session/session-manager.compaction.test.ts)、[compaction-failures](../../electron/session/session-manager.compaction-failures.test.ts) | 压缩与失败边界                         |
| [session-provider-retry.test.ts](../../electron/session/session-provider-retry.test.ts)                                                                                                    | 重试分类、延迟与中断                   |
| [conversation-transcript.test.ts](../../electron/session/conversation-transcript.test.ts)                                                                                                  | 字面迁移和导出                         |
| [headless.test.ts](../../electron/headless/headless.test.ts)                                                                                                                               | Headless 的配置、工具、Plan 与运行结果 |

具体 Provider 的测试与实现同目录。真实 Provider 测试是另行明确选择的付费工作负载，见[开发指南](../guides/development.md)。

## 用量采集与上下文分解

[usage-observer](../../electron/providers/usage-observer.ts) 在实际主/辅助 Provider 请求收到用量时记录，包含已返回 usage 的失败；[provider-failure-usage](../../electron/providers/provider-failure-usage.ts) 保留传输中断前的指标，不改变错误分类。[context-usage](../../electron/session/context-usage.ts) 通过 [context-usage-projection](../../electron/providers/context-usage-projection.ts) 复用 Provider 输入投影，区分来源与工具定义，按有效历史计量序列化后的 UTF-8 字节数并生成有界分类。验证见[上下文测试](../../electron/session/context-usage.test.ts)、[采集测试](../../electron/providers/usage-observer.test.ts)与[持久化测试](../../electron/application/session-usage-service.test.ts)。
