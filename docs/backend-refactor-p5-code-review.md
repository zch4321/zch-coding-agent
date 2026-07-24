# Backend State v2 当前分支代码审查（P5 增量与遗留问题复核）

> 审查日期：2026-07-24
>
> 分支：`refactor/backend-state-v2`
>
> 当前提交：`3a469ad21442b14af4822992d7a33d3088d92519`
>
> 主线基线：`master` @ `38a5e55476ec7233012fbddd747fb71766e09344`
> P5 增量基线：`843829a`（上一份 P0–P4 报告覆盖的 HEAD）

## 结论

该分支已完成规模较大的后端状态重构：相对 `master` 涉及 163 个文件、约 21,948 行新增和 3,362 行删除；P5 相对上一轮基线涉及 56 个文件、约 6,448 行新增和 531 行删除。持久化会话、文件变更历史、控制命令持久化和懒加载生命周期的主路径已有明显改善，完整确定性测试与 E2E 也均通过。

但当前不建议将该状态作为生产切换或 P8 收尾的基线。审查发现 **3 个 P1、8 个 P2、1 个 P3**：其中既有可通过本地工作区竞争绕过文件回滚路径保护的问题，也有升级已有 v9 配置时直接删除整份配置的问题；另外，请求去重、文件快照完整性和历史压缩后的工具调用标识仍存在一致性缺口。

优先处理顺序应为：文件回滚竞态、配置兼容迁移、会话请求单飞；随后补齐文件快照与请求幂等语义的端到端完整性测试。

## 审查范围与方法

- 对 `master...HEAD` 及 `843829a...HEAD` 进行静态审查，重点查看 Electron 主进程、持久化 schema/migration、文件系统边界、会话状态机、共享契约及对应单测。
- 复核上一份 [P0–P4 审查报告](./backend-refactor-p0-p4-code-review.md) 中的高优问题在当前 HEAD 的处理状态。
- 运行结果：
  - `git diff --check master...HEAD`：通过。
  - `npm test`：112 个测试文件通过、2 个跳过；746 个测试通过、7 个跳过。
  - `npm run lint`、`npm run format:check`、`npm run typecheck`：均通过。
  - `npm run test:sqlite:packaged`：Node SQLite smoke 通过；Windows packaged smoke 因审查机为 macOS 按脚本设计跳过。
  - `npm run test:e2e`：29/29 通过。
- 未运行 `npm run test:real`：该套件需要真实的 `DEEPSEEK_API_KEY`，不属于确定性审查环境。

严重级别含义：P1 为上线或数据/安全边界阻断项；P2 为应在后续功能扩展前修复的正确性、兼容性或可靠性问题；P3 为可排期的可观测性与 UI 质量问题。

## P1：应在生产切换前修复

### P1-1：文件回滚存在检查后使用（TOCTOU）竞争，可覆盖、删除竞争方文件，并可在父目录替换时逃逸工作区

**位置**：`electron/application/file-change-filesystem.ts:31-64`、`88-130`

`readFileContentState()` 先从词法路径计算候选路径、`lstat`/`realpath` 校验，再将最初的 `absolutePath` 写入返回状态。`restoreFileContent()` 虽在写入前于 88-93、111-112 和 122-123 再次校验目标及父目录，但实际 `rename()` / `unlink()` 发生在这些检查之后（113、128、130）。

因此，外部编辑器、同步程序或拥有工作区写权限的本地进程可以在最后一次检查后替换目标：

- 补丁或写入回滚会用旧快照覆盖竞争方刚写入的内容；创建回滚会删除竞争方刚创建的文件。
- 更严重的是，已校验的父目录可在检查后被移动并替换为指向工作区外的符号链接。最终使用的是原始词法 `absolutePath`，`rename` / `unlink` 会重新解析该链接，从而在工作区外写入或删除文件。

`WorkspaceAccessCoordinator` 只能协调本进程内部写者，不能消除外部进程或文件系统对象变化带来的竞态。仅增加一次 `realpath` 复查也无法关闭检查与系统调用之间的窗口。

**建议修复**：将回滚实施为相对稳定目录句柄的 no-follow 原子操作（需要原生层时可使用 `openat`/`renameat` 风格能力），或重新设计为可检测、可恢复的两阶段操作，明确其 best-effort 语义。不要在校验后再凭未绑定到目录句柄的字符串路径执行破坏性操作。

**应补测试**：提供可控 hook，在最后一次校验之后分别注入“目标内容变化”和“父目录换成指向工作区外的链接”；断言不会覆盖、删除或越界写入。

### P1-2：未完成请求会被 LRU 淘汰，重试的新会话可与原请求共享所有权并关闭成功会话

**位置**：`electron/application/durable-run-application-service.ts:50-90`、`149-202`；`electron/application/live-session-context-registry.ts:57-107`

`DurableRunApplicationService` 的 `#requests` 同时承担“进行中的单飞表”和“最近请求缓存”。达到 1,000 项后，85-88 行会无条件删除最旧项，即使其 promise 尚未完成。相同 `sessionId`、`clientRequestId` 的重试随后可再次进入 `#startNew()`。

`LiveSessionContextRegistry.reserveNew()` 对同一保留请求返回同一个 `ownerToken`。在 `SessionManager.createSession()` 的异步路径（如路径保护与 MCP 初始化，约 297-331 行）中，两次启动可交叠；任一失败分支的 `releaseOwned()` 会按该共享 token 释放并关闭另一条、实际成功路径创建的 live session。`#startNew()` 的失败清理还会无条件删除 key，可能误删后续请求的 promise。

这需要超过 1,000 个未完成的新会话请求及一次重试，触发门槛不低，但一旦发生会造成用户刚创建的会话被关闭或首条消息丢失，属于过载场景下的生命周期正确性破坏。

**建议修复**：将 pending map 与已完成 LRU 分离，绝不淘汰未完成条目；同一 reservation 应映射到共享启动 promise，而非共享可独立释放的 owner token；所有 finally/catch 清理应做 promise/owner 身份比较后再删除或释放。

**应补测试**：构造超过容量的可阻塞 `createSession()`，淘汰压力下重试同一请求；验证只启动一次、失败分支无法关闭成功分支，并验证旧 promise 的清理不会影响新 promise。

### P1-3：新增必填配置字段但未升级 schema 版本，部署到已有 v9 配置会删除整份配置

**位置**：`shared/config.ts:231-234`；`electron/config/schema.ts:148`；`electron/config/migrations.ts:25-47`；`electron/config/store.ts:581-585`；`electron/config/store.test.ts:110-125`

P5 将 `limits.fileChangeHistoryBytes` 设为 v9 配置的必填字段，却没有提高 `schemaVersion`。已有用户的合法 v9 配置缺少该新字段时，`migrateConfig()` 会将其视为无效；`ConfigStore.#read()` 随即删除整个配置文件并改写默认值。现有测试正是通过删除这一个字段来断言“重置整份配置”。

这会在普通升级路径中丢失提供商设置、MCP 设置、规则、隐私偏好及其他用户配置；保密记录引用可能因此成为孤儿。它不是罕见损坏恢复，而是当前版本升级的确定性兼容性破坏。

**建议修复**：为新增字段提供版本化、保字段的迁移（或采用受控的默认值合并），并先写入 `.bak` 再处理不可恢复损坏。未知的更高版本应拒绝覆盖而不是重置。若配置中的秘密引用被删除，还需有安全、可审计的孤儿清理策略。

**应补测试**：以 P5 之前的完整 v9 配置为输入，验证仅填充新字段且所有其他字段逐项保留；分别覆盖损坏 JSON、缺失字段、未知更高版本和迁移失败回滚。

## P2：应在后续功能扩展前修复

### P2-1：文件变更快照会无上限读取外部替换后的普通文件，可能耗尽主进程内存

**位置**：`electron/application/file-change-filesystem.ts:38-47`；调用方 `electron/application/file-change-service.ts:182-191`

在检测符号链接与非常规文件后，`readFileContentState()` 直接 `readFile(canonical, 'utf8')`，没有先用 `stat.size` 限制读取量。哈希不匹配在内容已完整读入后才会发现。外部进程只要把目标替换成超大普通文件，即可使提交或回滚把该文件整体缓冲到 Electron 主进程。

现有工具层的 10 MiB 限制（`electron/tools/file-tool-limits.ts:1`）没有在此处复用，因而不能作为保护。

**建议修复**：在读取前检查大小并采用与文件工具一致或更严格的上限；若必须验证大文件，使用有硬上限的流式哈希/读取。超限或已变更都应稳定地报告 `RESOURCE_CHANGED`，而非尝试加载。

**应补测试**：在快照与回滚之间替换为超过上限的普通文件，验证进程不会读取完整内容，且不会执行写入/删除。

### P2-2：持久化的文件快照未与其保存的哈希交叉验证，损坏记录可恢复出错误内容

**位置**：`electron/persistence/file-change-codec.ts:166-195`；`electron/application/file-change-service.ts:347-355`；`electron/persistence/migrations/0001_initial.sql:171-200`

解码器验证了 schema、存在性、payload byte 数和哈希字段格式，但没有验证 `sha256(beforeContent) === beforeHash`，也没有校验 diff/快照关联哈希。`revert()` 直接把 `beforeContent` 交给文件系统恢复函数，未再次使用 `beforeHash`。

数据库损坏、错误导入或部分写入恢复时，一条“内容被替换、哈希字段仍是格式正确字符串”的记录可以通过验证并写回错误版本。普通 SHA-256 只能检测意外损坏；若威胁模型包含能修改数据库的攻击者，则还需要密钥化完整性保护，而不仅是裸哈希。

**建议修复**：在编码、解码或至少回滚前重算并验证内容哈希，拒绝不一致记录；根据本地数据库的攻击模型，评估 HMAC/受保护密钥的完整性标签。

**应补测试**：篡改 `before_content`、`before_hash`、payload 长度和 diff 字段的持久化行，验证加载或回滚可靠拒绝且不触碰工作区文件。

### P2-3：回滚未保留 POSIX 权限，删除或覆盖可执行文件后会变为 `0600`

**位置**：`electron/application/file-change-filesystem.ts:102-113`；`electron/persistence/file-change-codec.ts:20-23`

恢复过程以 `0o600` 创建临时文件（106 行）并通过 rename 覆盖目标（113 行）。记录仅保存回滚前内容，不保存模式、ACL 或其他元数据。因此，一个原本为 `0755` 的脚本被删除或被覆盖后回滚，会恢复内容但失去可执行位；覆盖回滚同样会替换目标的原权限。

**建议修复**：在记录创建时保存明确规定范围内的 `beforeMode & 0o777`，恢复时在 rename 前对临时文件 `fchmod`。需要单独定义 ACL、所有者、xattr 和特殊位的跨平台策略，避免暗中承诺无法恢复的元数据。

**应补测试**：对 `0755` 脚本的 patch、write 和 delete 进行提交及回滚，验证内容和权限都恢复；在非 POSIX 平台覆盖兼容分支。

### P2-4：请求幂等指纹只包含消息文本，忽略 selected context 与新会话语义

**位置**：`electron/application/durable-run-application-service.ts:50-63`、`116-121`；`electron/application/session-service.ts:229-257`；`shared/domain-state-api.ts:398-426`；`electron/application/session-user-turn-preparer.ts:117-139`

请求缓存和持久化查找以 `canonicalHash(input.message)` 作为冲突判定。相同 session、client request ID 与消息文本，但携带不同附件/选中上下文时，会被静默视作同一请求；不同项目、模型、模式、标题、目标等新会话初始化语义也未进入指纹。实际执行中 `context` 会被转为 `selected_context` 并影响 provider 输入和历史。

结果是客户端重试或 ID 复用时，用户看到的是旧 promise/旧结果，而不是可诊断的冲突，且实际执行内容与其当前请求不一致。

**建议修复**：定义版本化的 canonical request fingerprint，覆盖请求类型、消息、规范化 context 与新会话的所有语义字段；或者明确地禁止含 context 的同 ID 重试。将该指纹持久化，并在内存与重启恢复两条路径做一致校验。

**应补测试**：相同 ID+文本、不同附件/上下文应得到冲突；相同 ID+文本、不同新会话元数据同样应冲突；完全相同输入仍应稳定复用。

### P2-5：历史压缩后可重用工具 call ID，但文件变更表禁止相同 `callId + path`，导致成功写入不再有可回滚记录

**位置**：`electron/domain/canonical-history.ts:267-282`；`electron/persistence/migrations/0001_initial.sql:189`；`electron/application/file-change-service.ts:231-256`

canonical history 只检查仍处于 active history 的 assistant tool call ID；压缩将旧消息置为非活跃后，后续 provider 可再次使用相同 call ID。文件变更表却对 `(session_id, call_id, path)` 建立唯一约束。第二次同一路径变更的文件操作本身可以成功，但持久化会触发约束失败，并被转换为 `CHANGE_HISTORY_PERSIST_FAILED` 警告，用户失去该次变更的 revert 能力。

**建议修复**：统一两端标识语义：要么全 session 禁止重用 tool call ID，要么将数据库唯一键升级为真正的 assistant turn/message identity 加 call ID 加 path。不要把“文件已变更但历史未记录”降格为仅日志告警。

**应补测试**：压缩前后使用同一 call ID、同一路径执行 mutation，验证第二条 file change 可持久化并独立回滚，或在执行前返回明确可恢复错误。

### P2-6：第 513 个项目会被写入却无法被 API 返回或管理

**位置**：`shared/durable.ts`（最大值 512）；`electron/persistence/project-repository.ts:73-82`；`electron/application/project-service.ts:75-96`；`shared/domain-state-api.ts:495-509`

项目仓库列表 SQL 固定 `LIMIT 512`。服务层会先插入第 513 个项目，再返回列表；公开契约没有单项目 get 或分页接口。因此新项目的 ID 不会出现在 bootstrap/commit/list 结果中，用户无法再选择、更新或删除它。

**建议修复**：在达到上限时于插入前原子地拒绝，或实施分页与单项目查询并在 UI 中完整支持。上限应由数据库与服务层共同保证，不能只依赖返回列表截断。

**应补测试**：覆盖第 512 个与第 513 个创建，断言后者要么失败且不落库，要么可通过 API 立即发现和管理。

### P2-7：只含 reasoning 的合法 provider 完成会被拒绝，运行被标记失败

**位置**：`electron/providers/chat-completions-adapter.ts:335-363`；`electron/providers/deepseek-provider.ts:294-307`、`407-420`

适配器会收集 reasoning，但只把文本和 tool calls 转换为 canonical assistant parts；若完成响应不含两者，355 行会因 parts 为空而拒绝。DeepSeek provider 已可接收并转发 reasoning 字段，因此“只有推理、没有可见文本/工具调用”的正常耗尽或截断响应会被作为非法回复处理，不能进入持久化历史。

**建议修复**：在共享 assistant schema 中定义受控的 reasoning-only 表示，或在转换层以明确的无内容完成状态处理；不要依赖无意义文本占位符。需要同步确认 UI、prompt replay 与 trace 的展示策略。

**应补测试**：模拟仅有 reasoning 的 finish、stream completion 和截断响应；断言运行状态、历史、重试语义与用户可见提示都一致。

### P2-8：多个允许大小的附件汇总后可超过单条消息限制，正常请求会在历史落库前失败

**位置**：`shared/context.ts:39-44`；`electron/application/session-user-turn-preparer.ts:117-139`；`shared/message.ts:64-69`

`RunContext` 允许最多 32 个附件。预处理器读取并拼接这些附件为一条 `selected_context` 消息，但没有 aggregate byte/character cap；单条 message text 的上限是 1,000,000。以默认每附件 64 KiB 计算，约 16 个普通 ASCII 附件已可越界。

这不是仅限恶意输入：UI 正常允许的组合会在后续 canonical message 校验时失败。此前的恢复逻辑能减轻部分历史污染，但不能让这类正常请求成功。

**建议修复**：在 context 准备层施加总预算，必要时按可解释的优先级截断，或拆分为多条均受上限保护的 context 记录。前端需要在发送前显示预算与截断信息。

**应补测试**：构造总大小刚好低于和刚好高于上限的多附件请求；验证前者成功、后者得到结构化可解释错误或按预期截断，且不会写入半条用户 turn。

## P3：可观测性与界面质量

### P3-1：Prompt Inspector 的网格仍为六列，当前只渲染五项，来源与 token 栏被压窄

**位置**：`src/components/settings/LoggingSettingsPanel.vue:239-252`；`src/styles/settings-content.css:287-305`

P5 后每一行由一个 tag 与四个 span 组成，共五个 grid child；样式仍定义六个列轨道，第二和第四列只有 48 px。结果 source 与 token 的长值被椭圆截断，末尾还留有空列，削弱 Prompt Inspector 作为审计工具的可读性。

**建议修复**：将 grid 模板调整为与五个字段对应的列数和弹性比例，并在窄宽度下采用可读的堆叠或 tooltip 策略。

**应补测试**：增加长 source、长 token 值的组件/视觉回归用例，并覆盖窄窗口布局。

## 上一轮问题复核

当前实现已处理上一轮 P0–P4 报告中以下高优主路径：外键索引、provider/assistant canonical 校验、`/compact` 控制命令的 journal 流、会话 reservation owner token、持久化失败后的 reload/invalidate，以及懒加载的生命周期屏障。相关迁移、服务代码和测试均可见于当前 HEAD。

不过，上一轮的部分中优问题仍然成立，并在本报告中重新编号为：

| 上一轮编号 | 当前结论 | 本报告位置 |
| --- | --- | --- |
| M-1（reasoning-only completion） | 未解决 | P2-7 |
| M-6（配置迁移以整份重置为恢复策略） | P5 新增字段使其成为直接升级风险 | P1-3 |
| M-8（项目列表硬上限） | 未解决 | P2-6 |
| M-9（selected context 总量未受限） | 未解决 | P2-8 |

P5 尚未将这套 durable target 接入新的 renderer/preload 公共入口；在当前边界内，文件快照内容仍保留在后端持久化路径，没有发现 P5 新增的凭据向 renderer、trace 或子进程环境泄漏。

## 建议的修复与验证顺序

1. 先处理 P1-1：将文件回滚原语与已验证目录绑定，并为竞争和越界路径加入 deterministically controlled tests。
2. 处理 P1-3：提供兼容迁移与备份，使用真实旧 v9 fixture 验证无损升级；在发布前确认秘密引用的孤儿处理策略。
3. 处理 P1-2：重构请求缓存为 pending single-flight + settled LRU，覆盖容量压力与重试竞态。
4. 为文件历史补齐读取上限、内容哈希验证和权限元数据（P2-1 至 P2-3），将它们作为同一安全/可恢复性改动评审。
5. 统一请求指纹及 tool call ID 的持久化标识（P2-4、P2-5），并加入重启恢复、压缩和重试组合测试。
6. 再完成项目分页/上限、reasoning-only、上下文预算和 Prompt Inspector 布局问题（P2-6 至 P3-1）。

修复 P1 后，建议至少重复运行 `npm test`、`npm run lint`、`npm run typecheck`、`npm run test:sqlite`、`npm run test:e2e`；涉及文件系统边界的改动还应在 POSIX 和 Windows 打包运行时各验证一次。
