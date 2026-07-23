# Backend Refactor P3 Checklist

P3 在 `refactor/backend-state-v2` 分支完成 canonical in-memory history 与 Provider Protocol Adapter 切换；SQLite 仍只作为 P2/P3 的隔离开发基线，不提前成为产品用户状态真相源。

## Contracts and reset boundaries

- [x] Canonical kind 闭集包含 12 种消息，通用 `harness` kind 和 `promptLedger` 已删除。
- [x] 原始与 replay user identity 使用 `clientRequestId XOR replayedFromMessageId`。
- [x] AppConfig v9 包含 `adapterId` 与单调 Provider `revision`；旧配置要求重置。
- [x] `0001_initial.sql` 已更新；旧 P2 开发数据库通过 checksum/schema 错误要求删除重建。
- [x] Trace v2 记录 canonical source、冻结 route、wire request、canonical completion 与 raw response；v1 明确拒绝。

## Runtime and protocol

- [x] Core history 不保存 Provider role 或 Chat Completions wire 字段。
- [x] `MessageHistoryCompiler` 校验 schema/bounds、seq、Session、active epoch、compact boundary 和完整有序 tool batch。
- [x] DeepSeek 与 generic OpenAI-compatible route 分别使用独立 adapter id。
- [x] Chat Completions Adapter 与 HTTP/SSE transport 分离。
- [x] Run 冻结 main/compression/approval route、credential 与 model profile；变更只影响下一 Run。
- [x] `beforeLLMCall` 只接收深拷贝 DTO，保护 route/model/tools/credential，并在发送前重新做 DTO 与预算检查。
- [x] Responses/Anthropic 只存在 test-only shape adapters，不进入产品配置。

## Compact ordering

- [x] 自动：`system → harness* → root user replay → compact summary`。
- [x] 自动 summary 是 Chat Completions 的最后一个 user-role continuation。
- [x] 工具进展与 interjection 包含在 summary 输入中，不把半个 tool batch 写入新 epoch。
- [x] 无 root user 的 harness-driven Run 省略 replay。
- [x] 手动纯 `/compact`：`system → harness* → summary`，展示后结束。
- [x] 手动 `/compact <正文>`：`system → harness* → summary → new user`，随后开始 React。
- [x] 失败、abort、空 summary 不改历史；重建仍超限不递归 compact。

## Removal and gates

- [x] Trace fork/start-fork shared contract、IPC/preload、Session override、renderer control 与测试已删除。
- [x] 普通 Session fork 保留。
- [x] Core/Persistence/Renderer 架构 grep 不出现 Chat wire DTO 字段。
- [x] Deterministic unit/integration、DeepSeek golden、Electron/Headless parity 覆盖新边界。
- [ ] `test:real` 仍为 opt-in，不作为 P3 gate。
