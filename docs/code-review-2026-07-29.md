# 代码审查报告 · 2026-07-29

> 审查对象：`feat/responses-anthropic-providers` 分支（HEAD `7e33e23`），全仓库约 9.3 万行 TypeScript/Vue（`electron/` 264 文件、`src/` 76 文件、`shared/` 38 文件、`e2e/` 14 文件）。
> 审查方式：按 9 个范围分区通读（IPC 与安全边界、Agent 运行时与工具、Provider/网络/MCP、持久化与应用服务、渲染进程、shared 契约、构建与进程、测试体系、架构一致性），所有发现均附 `file:line` 证据；标注"待确认"的条目表示审查时未能完全核实。
> 配套文档：本文结论应与 [`architecture.md`](./architecture.md)、[`decision-log.md`](./decision-log.md) 对照阅读。

---

## 1. 总体结论

项目整体工程质量**高于同类项目平均水平**。核心安全红线实现可靠：渲染进程沙箱化、preload 暴露面收敛、IPC 全链路契约校验、workspace 路径守卫（realpath + 读中复查）、审批管线四层 fail-closed、审批到执行的 TOCTOU 缓解、子进程环境白名单、SSRF 钉扎防护、SQLite 迁移与事务不变量下沉到数据库约束。`any`/`@ts-ignore`/TODO 三项技术债温度计全部为零，进程边界有机械化测试守护且手工复核零违规。

残余风险集中在**防线之间的不一致**，而非已建模的防线之内：

- 2 个 High 是"项目自己建立的信任/边界模型被另一条平行路径绕过"（git 写工具绕过 PathGuard、Serena 绕过 MCP 指纹信任）；
- 2 个 High 是凭证边界的一致性缺口（MCP `env` 明文进 renderer、Anthropic `x-api-key` 跨源重定向转发——后者定 Medium，但同属一类）；
- 1 个 High 是构建管线的平台一致性（非 Windows 主机静默产出损坏的 Windows 包）；
- 1 个 High 是渲染层已实证的正确性 bug（markdown 占位符替换）；
- 1 个 High 是文档漂移（architecture.md 自称"当前实现的规范"，但其 SQL DDL 已明显落后于 migration 实现）。

综合评级：**代码质量 A-，安全风险中**。无 Critical 发现；建议在本迭代修复全部 High，下一迭代消化 Medium。

## 2. 发现汇总

| # | 级别 | 位置 | 摘要 |
|---|------|------|------|
| H1 | High | `electron/tools/git-tools.ts:499-508,550-573` | git 工具 pathspec 绕过 workspace 路径守卫 |
| H2 | High | `electron/code-intelligence/serena-mcp-adapter.ts:686-735` 等 | Serena 启动绕过 MCP 指纹信任模型，workspace 可控配置可被低审批工具触发执行 |
| H3 | High | `shared/mcp.ts:35` + `shared/config.ts:416` + `electron/config/schema.ts:280` | MCP `env` 明文值经 `PublicConfig` 进入 renderer |
| H4 | High | `package.json:10` + `electron-builder.json5:6-9` | 非 Windows 主机 `npm run build` 静默产出损坏的 Windows 安装包 |
| H5 | High | `src/markdown.ts:151-153` | `String.replace` 替换串解释 `$&`/`` $` `` 特殊模式，代码块渲染损坏（已实证） |
| H6 | High | `docs/architecture.md:741-840,586-590` | §6.6/§6.7 SQL DDL 与 migration 实现严重漂移，"文档即规范"失效 |
| M1 | Medium | `electron/providers/generic-anthropic-provider.ts:304-307` 等 | Anthropic `x-api-key` 在跨源 HTTP 重定向时被转发给重定向目标 |
| M2 | Medium | `electron/providers/http-sse-transport.ts:91` + `session-provider-turn.ts:164-169` | provider 流式请求无任何超时与停滞检测 |
| M3 | Medium | `electron/session/session-provider-turn.ts:133-154` + `prompt-harness.ts:510-566` | 每个 agent step 全量重建 runtime context（多次 git spawn + 递归 readdir） |
| M4 | Medium | `electron/session/prompt-harness.ts:183-203,531-558` | 不可信仓库内容未转义进入模板；值含 `${` 直接打爆 session |
| M5 | Medium | `electron/tools/file-tool-atomic.ts:52,65-73` | atomicReplace 不保留原文件权限位（0o755 变 0o600） |
| M6 | Medium | `electron/tools/tool-registry.ts:369-379` | supportsAbort 工具无结算竞速，插件工具可架空超时并产生 zombie 写 |
| M7 | Medium | `electron/tools/file-tool-policy.ts:29-103` + `terminal-tools.ts:144-176` | `terminal_send` 无确定性危险信号扫描，比 `run_command` 少一层防线 |
| M8 | Medium | `electron/config/store.ts:647-655` | 配置损坏/版本不兼容直接 `rm` 无备份（降级路径亦清空配置） |
| M9 | Medium | `electron/config/secret-store.ts:164-193` + `main.ts:138,423-426` | secrets.json 损坏导致应用启动即退出，无恢复路径 |
| M10 | Medium | `electron/config/secret-store.ts:102-124,195-197` | SecretStore 无写入串行化，并发 persist 可丢失凭证 |
| M11 | Medium | `src/markdown.ts:40-42,151-153` | fence 占位符 marker 可被消息正文碰撞 |
| M12 | Medium | `src/locales/*` × `agent-runtime.ts:1124-1130` | i18n 缺口：4 个 RunStatus 无翻译，侧栏 badge 显示原始 key |
| M13 | Medium | `src/stores/agent.ts:25-49,56-105,202-275` | facade 类型与运行时清单漂移：webSearch 成员类型存在、运行时 `undefined` |
| M14 | Medium | `shared/agent-events.ts:14` 及 20 个分支 | 事件 schema 缺 `additionalProperties: false`（全契约层唯一缺口） |
| M15 | Medium | `shared/ipc-contract.ts:173` + `shared/config.ts:457-718` | `config:set` 版本字段语义与 `IPC_VERSION` 脱节（当前碰巧相等） |
| M16 | Medium | `shared/json.ts:15` + 各出向契约 | 出向消息无字节级上限，`JsonValueSchema` 完全无界 |
| M17 | Medium | `scripts/run-real-api-tests.cjs:14` | 引用不存在的 `electron/agent/real-api.test.ts`，`test:real` 必然失败 |
| M18 | Medium | `shared/terminal.ts:29` vs `shared/config.ts:255-258` | scrollback 配置上限（100MB）与 snapshot IPC 校验上限（2MB）不一致 |
| M19 | Medium | `e2e/durable-session-terminal.spec.ts:226-230` | PTY 断言无法区分命令执行与终端回显，全平台可能假绿 |
| M20 | Medium | `electron/safety/path-guard.test.ts:56-75` | symlink 逃逸测试在 EPERM/EACCES 时静默 return 报绿 |
| M21 | Medium | `e2e/features.plan.spec.ts:153-154` | 固定 250ms sleep 窗口做负向断言（时序脆弱） |
| M22 | Medium | `src/markdown.ts` 全文件 | 渲染层安全敏感代码零单测（validateLink/fence 替换均无覆盖） |
| M23 | Medium | 6 个文件 | 超过 AGENTS.md 1000 行约定（3 个生产核心 + 2 个测试 + 1 个压线） |

Low 级发现 20 余条，按域汇总于 §5。

---

## 3. High 级发现详述

### H1 · git 工具 pathspec 绕过 workspace 路径守卫

`electron/tools/git-tools.ts:499-508, 550-573, 284-318`。`git_add`/`git_restore`/`git_diff` 的 `paths` 只拒绝以 `-` 开头的值（防 option 注入），不校验路径本身。当 workspace 是 git 仓库的**子目录**时（PathGuard 只要求 workspace 是存在的目录，git 工具以 workspace 为 cwd），`git_restore -- ../sibling` 会销毁 workspace 之外、仓库之内的未提交改动；`git add -A`（:513）会暂存整个仓库而非 workspace 子树；`git_diff -- ../x` 可读仓库外文件 diff。

- **影响**：这是当前唯一能确凿越出 workspace 边界的写路径——文件写工具走 PathGuard，唯独 git 写工具不在其边界内，违背项目自己声明的红线。yolo 模式下静默越界写/删；confirm/auto 模式下仅靠人工/审批模型注意到 `../` 参数。
- **建议**：对 PATHS_FIELD 逐项用 `PathGuard.resolveCandidate()` 校验（或拒绝含 `..` 的 pathspec 与绝对路径）；`git add -A` 改为 `git add -- .` 限定 cwd 子树。

### H2 · Serena 启动绕过 MCP 信任模型

`electron/code-intelligence/serena-mcp-adapter.ts:686-735`、`backend-manager.ts:195`、`electron/project/project-metadata-store.ts:378-403`、`electron/tools/code-intelligence-tools.ts:105-106`。Serena 的启动配置（`command`、`extraArgs`、`cwd`）来自 workspace 内的 `.zch/project-model.json`，读取时无任何信任校验；agent 的 `code_*` 工具标记为 `defaultRisk: 'low'` + `effects: ['code.read']`，执行时惰性启动 Serena 进程。而项目自己的 `McpManager` 对同类操作建立了指纹哈希 + `isTrusted` + `trustAndEnable` 的显式信任模型（`mcp-manager.ts:577-591`），Serena 完全绕过了它。

- **影响**：恶意仓库自带 `.zch/project-model.json`（`serena.enabled: true`、`command: "./pwn.sh"`——spawn 时 libuv 先 chdir 到 workspace 再 execvp，相对路径可解析到仓库内脚本），用户打开该 workspace 后，agent 一次自动批准的低风险代码查询即触发任意命令执行，全程无用户确认。
- **建议**：将 Serena 启动纳入与 `McpManager` 相同的指纹信任模型（对 command/args/cwd/enabled 计算 fingerprint，首次启动或配置变更时要求用户确认）；或对 workspace 提供的配置仅信任非执行类字段。

### H3 · MCP `env` 明文值经 PublicConfig 进入 renderer

`shared/mcp.ts:35`（`env: Record<string,string>`，单值上限 16_384）被原样纳入 `PublicConfigSchema.mcpServers`（`shared/config.ts:416`），`config:get` 经 IPC 送达 sandboxed renderer；`electron/config/schema.ts:280` 的 `toPublicConfig` 对 `mcpServers` 只做 `structuredClone`，无脱敏。项目自身已认定该字段敏感——`launchPreview` 把 env 显示为 `[configured]`（`mcp-manager.ts:648-652`），且这些值会被注入子进程环境，是 MCP token/API key 的惯用存放位置。

- **影响**：违反"凭证不得进入 renderer"红线；任何 renderer 侧漏洞（XSS、依赖供应链）可直接读取全部 MCP 密钥。
- **建议**：契约层拆分——`PublicConfig` 中的 MCP 条目改为不含 `env`/`envFromHost` 值的公共投影（保留键名与 `hasEnv` 元数据），env 写入走专用通道（类似 credential 的 `kind: 'credential'` 模式，`shared/config.ts:574-592`）。

### H4 · 非 Windows 主机 `npm run build` 静默产出损坏的 Windows 安装包

`package.json:10` 在任何平台无条件执行 `electron-builder --win --x64`。实证：本仓库 `release/0.2.4/win-unpacked`（macOS 主机本地构建产物）中 `resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-x64/bin/rg` 为 Mach-O x86_64 二进制，且包内完全不存在 `@vscode/ripgrep-win32-x64`（platform optionalDependencies 安装时按宿主平台过滤）。Windows 上运行时 `require.resolve('@vscode/ripgrep-win32-x64/bin/rg.exe')` 必然抛错（`electron/tools/ripgrep-searcher.ts:59-65`），ripgrep 搜索整体不可用。node-pty 不受影响（单包全平台 prebuilds）。官方 release 流水线（`windows-latest`）不受影响；`test:sqlite:packaged` 在非 win32 直接跳过，无任何告警。

- **影响**：开发者在本机执行 `npm run build`/`verify` 产出看似成功实则残缺的 Windows 安装包。
- **建议**：限定 Windows 打包只在 Windows runner/容器执行；为 win-unpacked 增加 packaged 版 ripgrep/node-pty 冒烟（仿照 sqlite-smoke `--packaged`）；或跨平台构建时强制安装目标平台 optional deps。

### H5 · markdown 占位符替换串解释 `$` 特殊模式（已实证）

`src/markdown.ts:151-153`：`.replace(fence.marker, rendered)` 中 `rendered` 作为 replacement string，会解释 `$&`、`$'`、`` $` ``、`$1` 等特殊替换模式。已在本仓库直接执行 `renderMarkdown` 实证：代码块中 `echo $1 and $&` 的输出里 `$&` 被展开为 marker 自身，`` $` `` 被展开为匹配点之后的全部文本；纯文本 fallback 同样中招。

- **影响**：`MarkdownBlock` 渲染的所有聊天消息代码块。shell/Perl/sed/JS 正则替换是常见代码内容；agent 读文件结果若以代码块呈现，任意文件都可能含这些序列。属正确性 bug，非 XSS（展开内容仍是已 escape 的页面文本）。
- **建议**：函数式替换——`.replace(fence.marker, () => rendered)`，一行改动；同时新增 `markdown.test.ts` 回归（见 M22）。

### H6 · architecture.md 的 SQL DDL 与 migration 实现严重漂移

文档自称"本文同时是当前实现的规范"（architecture.md:7），但：

- **§6.6 messages 表**（architecture.md:741-791 vs `migrations/0001_initial.sql:59-171`）：缺 `visibility`/`turn_id`/`replayed_from_message_id`/`derived_from_message_id` 四列；缺 4 个实际存在的 CHECK；kind 集合含实际不存在的 `'harness'`（且与文档自身 §5.3 "不存在通用 harness kind" 自相矛盾）；索引定义不符（实际为 `(session_id, visibility, in_history, seq)`）。
- **§6.7 file_changes 表与 §5.4 StoredFileChangeRecord**（architecture.md:807-840,586-590）：缺 `assistant_message_id`、`before_mode`、`workspace_path` 三列；UNIQUE 约束与实际不符；§5.4 接口同样缺字段。`decision-log.md:36-41` 的决策恰恰以 `assistant_message_id` 软关联为前提——decision-log 比 architecture.md 更新。

- **影响**：以该文档为准的实现者会写出错误 DDL/查询；revert 流程依赖的 `beforeMode` 在文档 schema 中根本不存在；文档权威性受损。
- **建议**：用 0001/0002 migration 的实际定义重写 §6.6/§6.7/§5.4，或改为引用 migration 文件而非内联 SQL；把 P0–P12 迁移叙述归档到独立历史文档以降低未来漂移面。

---

## 4. Medium 级发现详述

### 凭证与网络（M1、M2）

- **M1 · Anthropic `x-api-key` 跨源重定向转发**：`HttpSseTransport` 与 `fetchAnthropicModelCatalog` 用全局 `fetch`，未设 `redirect`，undici 默认 follow。已核实 undici 的 `cleanRequestHeaders`：跨源重定向仅剥离 `authorization`/`cookie`/`proxy-authorization`/`host`，`x-api-key` 不在剥离列表，会原样转发到任意重定向目标。Bearer 方案恰好被保护，Anthropic 方案没有。项目自己的 `ssrf.ts:97-110` 已有正确的 `stripSensitiveHeaders`，但只用于 fetch 工具。**建议**：provider 请求统一 `redirect: 'error'`（API 端点本不应重定向），或改 `manual` 并复用 ssrf 的 same-origin 校验 + 敏感头剥离。
- **M2 · provider 流式请求无超时与停滞检测**：`HttpSseTransport` 的 `timeoutMs` 默认为 0（禁用），生产调用点均不传；代码库不存在 run 级兜底超时（已 grep 确认，测试明确断言此为有意设计）。TCP 半开或服务端静默时该轮 turn 无限挂起，只能靠用户手动 abort。**建议**：增加读空闲看门狗（连续 N 秒无 SSE chunk 即 abort 并映射为 `TIMED_OUT`），而非总时长定时器，以兼容长流式响应。

### Agent 运行时与工具（M3–M7）

- **M3 · 每步全量重建 runtime context**：`callProvider` 每步执行 `runtimeContext()`：`gitSummary` 最多 spawn 5 个 git 进程、`projectTreeSummary` 递归 readdir 至 300 项。hash 比对只避免重复追加 history，不避免重新采集。大仓库单次 `git status` 即可能接近 1.5s 超时，长 run 延迟与子进程开销显著放大。**建议**：按时间窗或 fs 事件缓存，或仅在 mode 变化/固定步数间隔时重建。
- **M4 · prompt 模板注入面 + `${` 崩溃**：(a) `gitSummary`（commit message、分支名）、`projectTreeSummary`（文件名）直接插入模板，无引用/转义，commit message 可伪造指令或闭合 `</environment_context>` 标签；(b) `renderPromptTemplate` 末尾 `if (rendered.includes('${')) throw` 对**值**中的 `${` 也抛错——名为 `${x}.md` 的文件或含 `${HOME}` 的提交信息会使 session 创建与每次 `callProvider` 抛错，session 永久不可用（确凿健壮性 bug）。**建议**：只替换已知变量、不检查值侧残留；对 git/tree 采集内容用 CDATA 式引用包裹并过滤控制字符。
- **M5 · atomicReplace 丢权限位**：临时文件固定 `0o600`，rename 后不 chmod；`expectedMode` 已在 precondition 中记录但仅用于变更检测。`apply_patch` 修改 0o755 脚本后丢失可执行位。**建议**：rename 前按 `precondition.expectedMode`（存在时）对临时文件 chmod。
- **M6 · supportsAbort 工具缺结算竞速**：`tool-registry.ts:369-379` 对 abortable 工具直接 `await executed`，无 race；不响应 signal 的插件工具（经 `PluginEventBus.registerTool` 直达 registry）会让 run 永久挂起，且不在 `pendingSideEffects` 追踪范围，`closeSession` grace 超时后会产生与新 writer 并发的 zombie 写。**建议**：supportsAbort 路径同样 race 超时/abort，超时后按 timeout 结算并挂入 `pendingSideEffects`。
- **M7 · `terminal_send` 无危险信号扫描**：`processPolicySignals` 的 dangerousPatterns（rm -rf、git push 等）只匹配 `run_command`；`terminal_send` 向持久 PTY 写任意数据，效果等同 shell 执行，却不产生 danger 信号，auto 模式下直接落到审批模型，比 `run_command` 少一层确定性防线。**建议**：对 `terminal_send` 的 `data` 复用同类内容扫描。

### 配置与凭证韧性（M8–M10）

- **M8 · 配置损坏即删无备份**：`store.ts:647-655` 对 JSON 损坏、schemaVersion 不兼容（用户降级）、v12 多出未知字段三类场景一律 `rm` + 重置默认值，其中后两类是正常升级/降级路径而非损坏；`apiKeyRef` 指向的密钥记录成为孤儿。**建议**：删除前重命名为 `config.json.corrupt-<timestamp>` 保留；或对更高版本配置拒绝启动并提示而非重置。
- **M9 · secrets.json 损坏启动即退出**：`SecretStore.#read` 只对 ENOENT 容错，SyntaxError 直接上抛导致 `app.exit(1)`，仅有 console.error；与 config.json"静默重置"的处理完全不一致，且无用户可见的恢复指引。**建议**：按"凭证全部丢失"降级处理（备份损坏文件后从空 records 启动），或复用启动恢复对话框。
- **M10 · SecretStore 无写入串行化**：`set()` 异步加密后整体快照持久化，两个并发 persist 可发生"先快照者后落盘"导致凭证丢失；且 `get()` 在 `shouldReEncrypt` 时内部触发 `set()`，与正在进行的更新竞争（ConfigStore 已有 `#mutation` 队列，SecretStore 没有）。**建议**：加一条相同的 promise 尾链串行化所有 `#persist`。

### 渲染进程（M11–M13）

- **M11 · fence marker 可被正文碰撞**：marker 为可预测字面量 `@@SHIKI_FENCE_N@@`，消息正文恰好包含该字符串时第二次 `.replace` 会把正文替换为代码块 HTML。概率低但可构造。**建议**：函数式替换 + 渲染前校验 marker 唯一性，或改用一次性 split/重组。
- **M12 · i18n 缺口**：`RunStatusSchema` 含 `calling_llm | evaluating_tools | awaiting_approval | running_tools`，locale 的 `chat.status.*` 只有 7 个其他 key；已用脚本比对确认这 4 个状态下侧栏 badge 显示字面 key。**建议**：补全翻译（zh/en 各一份）或映射到既有 badge 枚举。
- **M13 · facade 类型/运行时漂移**：`AgentFacade` 类型层面包含 webSearch 全部成员，但 `settingsProperties` 与 `actions` 清单均不含（grep 0 匹配），经 facade 访问会拿到 TS 声称非空的 `undefined`。当前 `WebSearchSettingsPanel.vue` 绕过 facade 未触发故障，属定时炸弹。**建议**：补进清单，或在 Omit 中显式排除并文档化；另建议加开发期自检（遍历 store 成员断言 ⊆ 清单）。

### 契约层（M14–M16）

- **M14 · agent-events 缺 `additionalProperties: false`**：脚本全量扫描证实 `shared/` 全部 `Type.Object` 中只有 `agent-events.ts` 这 20 处缺失（TypeBox `Type.Composite` 输出不携带该关键字）。main 侧出站校验不会拒绝夹带额外字段（如 `stack`、内部诊断）的事件，与 `BackendNotificationEnvelopeSchema` 有专门测试拒绝 `stack` 形成鲜明反差。**建议**：为 composite 分支统一补 `additionalProperties: false`，并加"事件拒绝未知字段"回归测试。
- **M15 · `config:set` 版本语义脱节**：所有通道 payload pin `version: Type.Literal(IPC_VERSION)`，唯独 `config:set` 复用 `ConfigSetRequestSchema`，其 `version: Type.Literal(1)` 是 DTO 自己的版本号。当前两值碰巧都是 1；`IPC_VERSION` bump 即分裂。**建议**：统一引用 `IPC_VERSION` 或加独立 envelope。
- **M16 · 出向消息无字节上限**：`JsonValueSchema = Type.Unsafe({})` 在 AJV 下对任何值通过；`validatePayloadLimits` 只作用于入向。极端例：`SessionTranscriptEntrySchema.text` 允许单条 32 MiB × 一页 100 条 ≈ schema 层面允许 ~3 GB 单次 IPC 结果。现状靠部分 producer 自觉调用 `assertBoundedJsonValue` 缓解。**建议**：出站 result/事件在 event-sink/handler 层复用 `validatePayloadLimits`；契约层文档化该不变量；transcript 单条上限下调至与分页预算匹配的量级。

### 构建与脚本（M17、M18）

- **M17 · `test:real` 必然失败**：脚本写死 `electron/agent/real-api.test.ts`，实际文件为 `electron/session/real-api.test.ts`。**建议**：更正路径。
- **M18 · scrollback 上限不一致**：`terminalScrollbackBytes` 允许配置到 100 MB，而 `terminal:snapshot` 结果按 `TerminalSnapshotSchema.data` maxLength 2 MB 强校验——合法配置导致终端快照功能报错。**建议**：对齐两处上限，或 snapshot 返回前按 schema 上限截断。

### 测试体系（M19–M22）

- **M19 · PTY 断言假绿**：非 Windows 上 `Write-Output` 必然 `command not found`，但键入的命令本身被 PTY 回显到 xterm-rows，断言照样通过（Windows 上亦然）。**建议**：断言输出独占一行且与输入行区分，或按平台选择命令。
- **M20 · symlink 测试静默跳过**：`path-guard.test.ts:56-75` 在 EPERM/EACCES 时静默 return 报绿，安全关键分支是否真正执行不可观测（CI runner 特权**待确认**）。**建议**：改 `ctx.skip()` 显式标记，或注入 realpath 抽象做不依赖文件系统特权的分支测试。
- **M21 · sleep 窗口负向断言**：`features.plan.spec.ts:153-154` 用 250ms 时序窗断言"拒绝 plan 后不触发新 run"，慢机器假红、迟发回归假绿。该 spec 已启用 traceLogging，可改为等待 trace 落盘 `plan.status rejected` 后再断言。
- **M22 · `src/markdown.ts` 零单测**：`validateLink` 协议白名单、`link_open` 注入、fence marker 替换均无测试，而输出直接进入 v-html。CSP e2e 提供纵深兜底但不覆盖链接协议向量。**建议**：新增 `markdown.test.ts`，覆盖 `javascript:` 链接、HTML 注入转义、marker 冲突三类用例（与 H5 修复一并落地）。

### 约定偏离（M23）

6 个文件超过 AGENTS.md 1000 行约定（约定明确包含测试文件）：`durable-backend-runtime.test.ts`（1170）、`session-manager.ts`（1164，30+ 私有字段、145 行构造函数手工接线）、`agent-runtime.ts`（1138，六类职责）、`application-services.test.ts`（1065）、`session-service.ts`（1035）、`agent-settings.ts`（恰好 1000，不满足 "below 1,000"）。三者均为高内聚领域核心且已有明确抽取方向，AGENTS.md 允许"genuinely cohesive"例外——**建议**按已识别方向拆分（如 session-manager 的 terminal 门面与 trace 管理各拆为薄 facade），或在 AGENTS.md 显式记录豁免理由。

---

## 5. Low 级发现汇总

**安全/凭证**

- `electron/ipc/app-handlers.ts:417-451`：`workspace:open-file` 对任意 workspace 文件 `shell.openPath`，macOS `.command`/`.app`、Windows `.exe`/`.bat` 会被**执行**，无可执行类型过滤或确认闸门（渲染层确认 UI 待确认）。
- `electron/main.ts:288-310`：F12 DevTools 快捷键在生产包同样生效（self-XSS/社会工程放大器）。建议仅开发模式注册。
- `electron/security.ts:46-78`：`resolveAppResource` 不解析符号链接（需攻击者先能写 `dist/`，风险很小）。
- `electron/safety/path-guard.ts:162-206`：realpath 不覆盖硬链接，`workspace:read-file` 可读到 workspace 外被硬链接的文件。建议 `stat.nlink > 1` 时拒绝或文档声明边界。
- `electron/permission/policy-engine.ts:78-88`：remembered rules 用 `.find` 取首条，allow 可遮蔽 review（仅当存在重复约束规则时）。建议多条匹配优先 `review`。
- `electron/session/session-tool-runner.ts:449-464`：`tool.call` trace 不做 `redactJsonSecrets` 脱敏——模型读到 workspace 内含 key 的 `.env` 时，key 原样落 trace 文件。
- `electron/session/prompt-harness.ts:205-250`：git 探测子进程继承全部主进程环境，且未禁 `core.fsmonitor` 钩子——打开恶意仓库为 workspace 时 session 创建即可能执行仓库配置的钩子。建议 env 改用 `createCommandEnvironment()`，args 加 `-c core.fsmonitor=false --no-optional-locks`。
- `electron/mcp/mcp-manager.ts:604-620`：MCP stderr 脱敏只覆盖 `envFromHost`，`config.env` 明文密钥可经 `stderrTail` 状态泄漏到 renderer；Serena 侧 `redactions: []`（`serena-mcp-adapter.ts:694`）。
- `electron/mcp/mcp-stdio-connection.ts:146-156`：MCP 工具结果在连接层无大小上限，截断发生在物化之后，恶意 server 可造成内存放大。
- `electron/logging/logger.ts:85`：trace 文件未设 0o600（config/secrets 均为 0o600）；SQLite `agent.db` 同为默认权限。多用户机器上其他本地用户可读。
- `scripts/native-pty-smoke.cjs:59` 等 3 个冒烟脚本向子进程透传完整 `process.env`（`sqlite-smoke.cjs` 已示范 allowlist 做法）。
- `shared/model-route.ts:69-71`：`assertModelRouteSnapshotSafe` 允许 `http:` 端点，API key 明文出站（用户显式配置，建议 UI 警告非 loopback http 端点）。
- `electron/net/network-address.ts:96-107`：IPv6 私有地址判定未覆盖 6to4/Teredo 过渡地址（边缘场景，SSRF 主防线不受影响）。

**正确性/韧性**

- `electron/persistence/database-service.ts:182`：ROLLBACK 自身失败会掩盖原始错误，且连接永久卡在事务中（后续写路径全部 `NESTED_TRANSACTION_NOT_ALLOWED`，只能重启）。
- trace 写入侧无单文件上限：`MAX_TRACE_BYTES` 只在读取时生效，活跃 trace 不受清理策略约束，可持续写盘直到占满磁盘。
- `electron/runtime/runtime-event-bus.ts:66-77`：事件 schema 违规同步抛错，一个超限事件（如 error message > 64KB）可终止正常 run（是否存在实际超限路径待确认，MCP error message 是最可疑来源）。
- `electron/ipc/index.ts:178-197`：配置校验错误对渲染端呈现为无信息量的 `INTERNAL_ERROR`（用户无法得知哪项约束不满足）。
- `src/stores/agent-changes.ts:16-20`：`loadConversationChanges` 缺 try/finally，`changesLoading` 可能永久卡 true（同文件另一函数已正确使用 finally）。
- `src/stores/agent-runtime-events.ts:45-51,118-127,164`：多条 `void` promise 链无 `.catch`，桥接 reject 时产生 unhandled rejection（主进程 catch 覆盖范围待确认）。
- `electron/terminal/pool.ts:250-253`：按字节截取 scrollback 可能切断 UTF-8 多字节字符。
- `electron/process/run.ts:73`：注释声称处理 proxy 但实现没有；env allowlist 缺 macOS `TMPDIR`。

**UI/i18n/死代码**

- `src/components/artifacts/ProjectTab.vue:426`：硬编码英文 `'no capabilities'` 未走 i18n。
- 链接三处机制冗余且结果为"死链接"：`markdown.ts:45-55` 加 `target="_blank"`、`MarkdownBlock.vue:25-37` preventDefault、主进程 deny——链接可点击样式但点击毫无反馈。建议统一为无 href 样式或对 http(s) allowlist 走 `shell.openExternal`。
- `src/components/settings/SettingsPage.vue:43`：未知 tab 静默落到 logging 面板。
- `shared/conversation-titles.ts` 全文件死代码（仅自身测试引用，文件头注释声称被 UI 使用）；`shared/config.ts:26-27` `DeepSeekReasoningEffort` 死导出。
- `e2e/support/fake-provider.ts:30-31,134-143`：`armSecondResponseGate`/`releaseSecondResponse` 死代码。
- `electron/persistence/migrations/0001_initial.sql:78`：残留 `benchmark_context` kind（shared 已移除；migration 不可变约束下属合理遗留，建议 decision-log 补记保留理由）。
- 3 个 PascalCase 测试文件违反 kebab-case 约定：`ArchivedSessionsSettingsPanel.test.ts`、`ProjectTab.test.ts`、`AppMessageBridge.test.ts`。

**契约一致性小裂口**

- `shared/` 内部重复：`Sha256Schema` 两处逐字相同（runtime-identity.ts vs durable.ts）；MCP fingerprint 只约束长度无 hex pattern；`ContextWindowSourceSchema` 与 `capabilitySource` 四枚字面量重复定义；`PromptResourceRef` interface/Schema 双定义；notifications id pattern 与 ids.ts 重复。
- `schemaVersion: Type.Literal(12)` 在 shared 定义后 electron 侧又硬编码 6 处，建议 shared 导出 `CONFIG_SCHEMA_VERSION` 常量。
- `docs/architecture.md:104-117` §3.1 shared/ 文件清单过时（列了不存在的 `runtime-events.ts`，仅列 11 个实际 30+ 模块）。

**测试/工程**

- `electron/session/session-manager.compaction.test.ts:56,72,400`：跨事件 `setTimeout(20)` 桥接（同文件已有 `waitFor` 轮询工具）。
- `e2e/security-baseline.spec.ts:174,224,232`：三处 `waitForTimeout` 负向等待（flake 风险）。
- `electron/ipc/ipc.test.ts`：负向 schema 校验仅覆盖 3/58 通道（已有 `validPayloads` map，可低成本参数化"每通道破坏一个必填字段"的 sweep）。
- e2e 缺凭证泄露负向断言：多个 spec 已读取 trace 原文但从不断言 trace 不含 provider key——补一行 `expect(trace.raw).not.toContain(providerApiKey)` 即可闭环红线。
- e2e 无 run interrupt 用例（UI 停止按钮→abort→终态链路仅 unit 层覆盖）。
- `vitest.config.ts` 已配置 v8 coverage 但无 `thresholds`，覆盖率可静默倒退；建议对 safety/permission/ipc 设最低线。
- `package.json` 无 `engines` 字段（`node:sqlite` 隐含 Node ≥22.5）。
- `.github/workflows/release.yml:16`：`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` 明确禁用代码签名（已知取舍，建议 decision-log 记录并在路线图排期 Authenticode）。

---

## 6. 做得好的地方（值得保持的设计）

1. **IPC 入口全契约化、单点注册**：channel 只在 `shared/ipc-contract.ts` 定义一次，`ipc/index.ts` 统一执行 sender 三层校验（WebContents 身份 === 主窗口 + 仅 mainFrame + frame origin 白名单）→ 体积/深度/原型上限 → payload schema → handler → result schema；未知错误统一映射为不含内部细节的 `INTERNAL_ERROR`。
2. **审批不可伪造、fail-closed**：`ApprovedToolCall` 品牌类型只能由 permission pipeline 铸造，执行前重校 argsHash 与文件 precondition（dev/ino/mtime/size/内容哈希/父目录身份），审批后目标被改动即 `RESOURCE_CHANGED`；超时/abort/模型不可用全部走向 cancelled 或人工，无默认放行；高危信号不可被 remembered rule 绕过。
3. **bounded output 贯彻全链**：子进程输出头尾保留 + discard 哈希、`boundResult` 二分截断、run 级 token 预算二次收敛、`read_file` 行/字节/token 三重上界。
4. **凭证卫生**：API key 仅经 `config:set` 入主进程 SecretStore（safeStorage 加密），public config 投影删除 `apiKeyRef`；子进程环境白名单重建；revision 钉扎防止冻结路由误用新配置；编译出的 provider request 不含凭证可安全进 trace。
5. **SSRF 防护教科书级**（skills URL 安装 + fetch 工具）：强制 https+443、禁凭证、DNS 解析后校验公网地址并以 `lookup` 钉扎 IP 防 rebinding、每跳重定向重新校验、次数/大小/超时全有界。
6. **MCP 注入防线**：启动指纹含 env 哈希、未信任不启动、工具调用要求先 `read_mcp_server` 披露且 revision 钉扎、AJV 双向校验、二进制结果省略、分页游标防循环、spawn 走 `shell: false`。
7. **持久化不变量下沉到 SQLite**：迁移 checksum + 单迁移事务回滚；串行写队列 + `BEGIN IMMEDIATE` + authorizer 禁嵌套事务；消息 append-only 由"内容列无任何 UPDATE/DELETE 路径"落实，rewind 不复用 seq；codec 双向 schema 校验。`durable-backend-runtime.test.ts` 用注入故障真实演练了 commit-before-provider、去重重放、binding 失效隔离等核心时序。
8. **abort 传播完整**：进程组 SIGTERM→SIGKILL 升级、审批等待随 abort 取消、ripgrep/worker/walk 均响应 signal；不可中止副作用工具的 settlement 被追踪并推迟 writer 释放，有专门并发测试。
9. **渲染层 XSS 防线分层**：markdown-it `html:false` + 协议白名单 + `rel="noreferrer noopener"`；`v-html` 全仓库仅 2 处且有注释说明依据；工具结果/diff/terminal 输出全部走插值或 `<pre>`。replica/overlay 双层 seq gap 检测与全量 resync 恢复。
10. **工程纪律**：生产代码零 `any`/零 `@ts-ignore`/零 TODO；公开 API 注释检查接入 verify 门禁且通过；`architecture-boundaries.test.ts` 机械化守护进程边界，手工复核其未覆盖方向零违规；legacy 路径删除有测试级证据（哨兵文件 + 闭集负向校验）；i18n 双语 540 keys 经脚本验证完全 parity。

---

## 7. 修复优先级建议

**本迭代（High，均不依赖架构改动）**

1. H1 git pathspec 校验 + `git add -- .`（安全红线）
2. H2 Serena 纳入指纹信任模型（安全红线）
3. H3 MCP env 公共投影脱敏（凭证红线）
4. H5 markdown 函数式替换（一行修复）+ M22 补单测
5. H4 限定 Windows 打包平台 + packaged ripgrep 冒烟
6. H6 architecture.md §6.6/§6.7/§5.4/§3.1 同步实现现状

**下一迭代（Medium 批次）**

- 凭证/网络：M1（redirect 策略）、M2（读空闲看门狗）
- 运行时：M4（`${` 崩溃 + 转义）、M5（权限位保留）、M6（abortable race）、M7（terminal_send 信号）、M3（runtime context 缓存）
- 配置韧性三件套：M8/M9/M10（备份、降级启动、写入串行化）——同属"小概率、高影响、修复成本低"，建议统一补齐并补测试
- 契约：M14/M15/M16
- 渲染层：M11/M12/M13
- 构建/脚本：M17/M18
- 测试加固：M19/M20/M21 + trace 凭证负向断言 + coverage thresholds

**可计划消化（Low）**：按 §5 分组随相关模块改动顺带处理；其中 tool.call 脱敏、git 探测环境白名单、trace 文件权限三条建议提前，因其触及项目自己声明的凭证/隐私红线。

---

## 8. 审查覆盖与局限

- 九个范围均做了全文件通读（非抽查），关键结论均有 `file:line` 或实命令输出佐证；H4/H5 与 i18n parity、schema 扫描、边界违规复核等结论经过在仓库内实际执行命令/脚本验证。
- 标注"待确认"的条目：`workspace:open-file` 渲染层确认 UI 是否存在、path-guard symlink 测试在 CI runner 的实际特权、runtime-event-bus 是否存在实际超限路径、renderer `void` promise 链的主进程 catch 覆盖范围。
- 本次审查为静态分析 + 局部实证，未运行动态渗透测试；`npm run test:real`（付费 Provider 路径）按 AGENTS.md 要求未执行。

---

## 9. 产品与功能视角补充审查（2026-07-29 追加）

> 本轮从最终用户与产品经理视角审查：对照 `docs/requirements.md` / `docs/frontend-spec.md` 逐条核实规格兑现度，并走查聊天/审批、设置/配置、终端/变更/通知、Agent 行为与交付形态五条产品线。§3–§5 已报告的问题（死链接、i18n 缺口、配置重置等）不重复列出。结论均有 `file:line` 证据，规格不符处两边引用。

### 9.1 总体结论

产品呈现**"内核严谨、最后一公里粗糙"**的特征：规格的主体能力（四档权限+审批卡、Skills 三入口、Trace/replay/导出、归档/恢复、retry/edit/rewind/fork、Plan 审阅门、Terminal 面板、通知体系）均已真实落地，road-map 声称"已落地"的条目抽查全部属实，v0.2.4 发布说明无夸大——**没有"规格写了但完全没做"的大块功能**。

最薄的一层是**状态诚实性**：多个界面上"UI 告诉用户的"与"系统真实发生的"不一致——

- 失败/被拒绝的工具调用显示绿色"成功色"标签（`ToolCallCard.vue:117-123`，颜色只看 `status==='completed'`，不看 result envelope）；
- Read-only locked 期间模式选择器强制显示"只读"，但 Session 持久化模式并未改——**UI 显示的是假值**（`MessageComposer.vue:611-631` vs `agent-runtime.ts:692-696`）；
- 点"批准计划"会向对话注入一条用户从未输入的"用户消息"（`agent-runtime.ts:1069-1080`），直接违反 `requirements.md:477`"不得伪装成用户消息"；
- 自动上下文压缩、取消运行、审批超时这三种关键状态转移在时间线上**完全隐形**（compact 摘要 `visibility:'hidden'` 且无事件投影；取消后流式内容被清掉且无标记；审批卡超时直接消失）；
- 权限页"默认模式"控件显示的是当前会话模式而非全局默认，全局默认会被无关的保存按钮隐式覆写。

其次是**降级/等待路径不解释**：正常路径反馈充分，但"等待审批/被锁定/拉取失败/进程已退出/导出成功"等路径上用户得不到可行动的信息。综合评级：**产品成熟度 B——工程师能用、普通用户会踩坑**，距"可交付给非开发者用户"还有一轮状态层与反馈层打磨的距离。

### 9.2 高优先级发现（阻碍核心用法或误导用户）

**P1 · Web 搜索凭据永远无法通过 UI 保存（`v-model` 笔误，整页功能失效）**
`src/components/settings/WebSearchSettingsPanel.vue:39` 使用裸 `v-model`，而 naive-ui `NInput` 只识别 `value`/`onUpdate:value`（全 `src/` 唯一一处，其余均为 `v-model:value`）。用户打字看起来正常，但 store 中 `apiKey` 始终为 `''` → `webSearchDirty` 恒 false → 保存按钮永远灰着；即使借别的字段触发保存，也会静默跳过凭据写入并显示"已保存"。无任何报错，e2e 对该页零覆盖。**建议**：改 `v-model:value`，补"输入 Key → 保存 → credentialConfigured"回归用例。

**P2 · Read-only locked 流程走死（规格 §7.3 未兑现）**
三处叠加：选择器被禁用且强制显示"只读"假值；`canSend` 不检查 writer 锁，用户照常发送后被后端以真实模式拒绝（`session-manager.ts:977` 抛英文 `CONFLICT`）；用户想按规格"显式改为 ReadOnly 再发起只读分析"也改不了（`setMode` 对所有模式直接 return false）。同 workspace 有 writer 时其他会话彻底死路。`frontend-spec.md:326` 明确要求"用户可以明确将 Session 模式改为 ReadOnly 后启动只读分析"。**建议**：选择器显示真实保存值并保持可切 readonly；非只读+锁定时禁用 Send 并用 tooltip 指明 writer 会话标题；CONFLICT 消息本地化。

**P3 · 权限页"默认模式"名不副实，可静默把 yolo 写成全局默认**
`PermissionsSettingsPanel.vue:36-56` 标为"默认模式"的 select 实际读写**当前会话**模式（`agent.defaultMode` 全页面无展示）；全局默认唯一的写入路径是敏感数据区那个只标"保存"的按钮（`agent.ts:239` 把 `runtime.mode` 夹带进 `defaultMode` 落盘）——用户保存几行 glob 或删除一条记忆规则时会无声改写全局默认；若当前会话是 yolo，全局默认直接变 yolo，**不经过任何 yolo 风险提示**。核心安全设置的语义与用户预期相反。**建议**：默认模式控件直接读写 `config.permission.defaultMode` 并与会话模式解耦；敏感数据保存不再夹带 `defaultMode`。

**P4 · 首次使用无引导，Send 未按规格禁用**
`canSend`（`agent-runtime.ts:264-276`）不查 `credentialConfigured`；`frontend-spec.md:512-513` 明确"Provider 未配置 → 配置提示 + Send disabled"。新用户第一关键路径断在最后一步：可以完整打字、点发送，然后收到一条英文 toast（`PRECONDITION_FAILED: "DeepSeek credential is not configured"`）。**建议**：`canSend` 加入凭据检查置灰 Send；placeholder 旁放"去配置 API Key"直跳按钮；可考虑首启落到 Provider 设置页。

**P5 · 审批超时静默消失 + 零 OS 通知 = "用户离开即丢审批"**
审批默认 10 分钟超时自动取消（`session-approval.ts:255-257`），卡片直接消失无失效态（违反 `frontend-spec.md:283`"显示失效状态"），工具结果 `"Approval was cancelled"` 与用户主动 Stop 不可区分；全仓库无 `new Notification`，窗口失焦后无任何打扰级通道。典型场景：agent 跑几分钟后弹审批 → 用户切走 → 无闪烁无通知 → 超时 → run 失败 → 用户回来只看到卡片没了。**这是 agent 产品的核心工作流断裂**。**建议**：审批卡保留失效态（"已过期，请重试"）；审批请求/即将超时/run 终态发 Electron 原生 Notification + 任务栏闪烁（内容注意脱敏）。

**P6 · 终端 tab 关闭零确认，一键强杀进程**
`TerminalPanel.vue:496` → `pool.ts:268-285` `pty.kill()`：tab 上的 × 一点就直接 kill，无"进程仍在运行"确认、无 undo。dev server、长构建、未保存的 REPL 状态误点即丢，且发生在小点击热区。**建议**：running 状态关闭前弹确认（复用 `ConfirmDialog`）。

### 9.3 中优先级发现（明显影响体验）

**状态呈现类**

- **工具卡无 Running 态，失败显示绿色成功标签**：`ToolActivity.status` 仅 `proposed|completed`（`agent-types.ts:49`），规格 §6.3 要求六态（`frontend-spec.md:243`）。长跑工具全程显示"待执行"；`error/denied/cancelled/timeout` 全部绿底+英文原文。**建议**：派生 running 态；按 result envelope 映射颜色与本地化文案。
- **批准计划注入伪造用户消息**（见 §9.1）：且若 `updatePlanStatus('active')` 成功而随后的 `sendMessage` 失败，计划显示 active 但没有任何执行，用户无恢复入口。**建议**：批准只写 Plan 状态 + harness/orchestrator 消息；失败时回滚或提示重试。
- **自动 compaction 完全不可见且静默消耗付费调用**（`session-compact-coordinator.ts:198-210` `emitText=false`；摘要落库 `visibility:'hidden'`；无 compaction 事件类型）。用户只看到对话停在"运行中"数十秒无任何输出，事后无法解释为什么后续回复"忘了"早期细节。规格 §6.2 要求展示 compact 摘要。**建议**：时间线插入系统态条目（"上下文已自动压缩 · 查看摘要"），期间 header 显示"正在压缩上下文"。
- **取消运行后时间线不留痕迹**（`ConversationHeader.vue:23-41` 对 cancelled 返回 `''`，overlay 清空）。切走再回来无法分辨"没回复"是取消、失败还是没发出去。**建议**：终态插入轻量状态条目并保留已生成的部分内容。
- **侧栏/Header 从未展示 Writer / Read-only locked**：`conversationStatus`（`agent-runtime.ts:1124-1130`）无任何代码路径产出这两个状态，`zh-cn.ts:154-155` 的翻译是死键；规格 §5.6/§6.1 未兑现。这正是 P2 中用户最需要的信息。
- **审批过期/中断后卡片静默消失**，`expiresAt` 以 ISO UTC 原文展示（`ApprovalCard.vue:41-43`）；终态后按钮在 `loadSession` 完成前仍可点，点了只收到后端报错。**建议**：原位失效态卡片 + 本地化倒计时 + 终态同步禁用。
- **run 无耗时显示与停滞感知**：src 全量 grep `elapsed|stall` 零匹配。叠加已知的"provider 流式无超时"，用户面对永远 Running 的会话没有任何决策依据。**建议**：header 显示已耗时，N 分钟无事件给出可 Stop 的非模态提示。

**错误与反馈类**

- **Run 失败通知不可行动**：任何失败一律 `RUN_FAILED` + provider 英文原文（`session-run-controller.ts:232-242`），UI 拿不到结构化 code，无法给出"去配置 Key/切换模型"入口；消息上的重试图标无任何引导。**建议**：主进程归类结构化错误码（auth/quota/network/model_not_found），通知按 code 本地化 + 跳转入口。
- **无任何成功/完成通知通道**：`notifications.ts:4` 只有 `warning|error`，无 OS 通知。长任务跑完、后台会话待审批，窗口失焦后零感知。
- **Linux 弱密钥后端无用户可见告警**：`secret-store.ts:87-88` 检测到 `weak_backend` 仅 `console.warn`，违反 `requirements.md:345`"必须明确告警"。**建议**：启动推送脱敏告警 + Provider 设置页展示存储后端状态。
- **Trace 风险告知被静默代签**：开启 logging 时自动写入 `traceNoticeAccepted`（`agent-settings.ts:943-954`），locales 中无任何告知文案，规格 §10.6 要求"独立风险告知"。对照 yolo 有完整弹窗。**建议**：首次开启弹独立告知确认再记录版本；hint 补充"工作区中被读取的凭据"（`requirements.md:441`）。
- **Provider 表单无字段级校验**：清空 Base URL/名称后保存，用户收到英文 schema 原文 toast（`Expected string length greater or equal to 1`），不知道哪行错（违反 `requirements.md:388`"字段校验留在所属界面"）。
- **模型目录拉取失败完全静默**：进页即以 `reportError=false` 静默刷新，失败无提示；`modelCatalogStale`/`fetchedAt` 已计算但无组件渲染；慢端点下保存按钮被进页自动刷新灰掉最长 15 秒且不解释原因。
- **关闭设置页静默丢弃未保存的 Provider 修改**：同页内切卡片有脏检查弹窗，点"返回主界面"却直接重置草稿（`App.vue:125-128`），行为自相矛盾。
- **Transcript 导出成功反馈不可见**：成功消息只出现在"设置→日志"面板，而导出动作发生在导出弹窗里（`traces.ts:253` vs `SessionTranscriptViewer.vue:134-142`）；失败有 toast，成功反而静默。另 trace 相关多处文案硬编码英文（`traces.ts:93-99,151-154,267-269`）。
- **revert 异常路径锁死 UI**：`agent-changes.ts:30-51` 无 try/finally，IPC reject 时 `revertingChangeId` 永不清空，所有 revert 按钮永久禁用；高频失败文案为后端英文原文。
- **死终端输入完全无反馈、退出码被丢弃**：`exit` 后继续敲键盘毫无反应（`accepted:false` 被 `void` 掉），tab 只显示英文 status、看不到退出码。**建议**：回写"进程已退出（exit code N)"提示行，status tag 走 i18n。

**机制可理解性类**

- **remember rule 精确匹配语义不可见**：`matchesConstraints` 逐字段 `JSON.stringify` 精确相等（`policy-engine.ts:59-76`）——"批准并记住" `npm run build` 后，`npm run test` 又弹审批，用户认为 remember 失效；UI 也未暴露后端已支持的 `global` scope 与 `expiresAt`，卡片不说明"此规则永久、仅参数完全一致时免审批"。核心减摩擦机制反噬信任。
- **四种权限模式产品内零解释**："自动"与"全自动"一字之差，无 tooltip 无说明；auto 依赖需单独配置的审批模型，未配置时静默退化为逐次人工审批，用户不知道为什么"自动"还老弹窗。
- **MCP 添加对普通用户断档**：手写 `config.json` 是规格决定，但 UI 不告诉用户写到哪个文件、不给示例、没有"打开配置文件"按钮（`McpSettingsPanel.vue`）；state/scope 显示英文原文。MCP 功能事实上只有读源码的用户能用。
- **搜索命中不能定位到消息**：后端已返回 `match.messageId`（`session-service.ts:285-295`），前端点击只打开会话（`ProjectSidebar.vue:195`），长会话里用户还得自己再找一遍。

**发布与桌面体验类**

- **无自动更新机制，UI 无法查看当前版本**：全仓库无 `autoUpdater`/`electron-updater`，但 `release/0.2.4/` 产出了只有 electron-updater 消费的 `latest.yml`+`.blockmap`；src 内无任何版本号/About 展示。已发布 4 个版本的产品缺发布闭环。**建议**：接入 electron-updater（产物已就绪），或至少在设置页显示版本号。
- **窗口尺寸/位置完全不持久化**（`main.ts:317-321` 硬编码 1120×760）；**启动先初始化后端再建窗**（`main.ts:414-422`），慢盘/首迁时双击图标数秒无窗口，零界面反馈。**建议**：持久化 bounds（含最大化态+多显示器校验）；先建窗显示骨架屏再挂载工作台。

### 9.4 低优先级发现汇总（打磨项）

**i18n 漏洞群**（zh 界面露英文，均建议走词条映射）：工具结果状态原文（`ToolCallCard.vue:33-35`）、Goal 状态原文（`GoalPanel.vue:24`，对照 PlanTab 已有正确做法）、writer 锁定 tooltip 硬编码英文且暴露内部 Session ID（`agent-runtime.ts:253-260`，应用会话标题替代）、终端 status 原文（`TerminalPanel.vue:512-519`）、MCP state/scope 原文、ApprovalCard 的 kind 与 policy signal 原文、审批过期 ISO UTC 原文、`chat.status.cancelled` 等死键。

**规格未兑现的打磨项**：Diff viewer 无语法高亮（`requirements.md:403`；`DiffTab.vue:125,261` 纯 `<pre>`）；文件 viewer 无行号且语言映射仅 5 种（`frontend-spec.md:371`；`FileCodePreview.vue:9-32`）；Files 不支持多文件 tab（`frontend-spec.md:359-367`）；Skills 列表不展示 trigger（`requirements.md:416`）；两侧栏宽度固定不可调（`frontend-spec.md:600-601`）；文件审批自动切 Diff 但不展开已关闭的侧栏（`frontend-spec.md:376`，与 Plan watcher 行为不一致）；顶栏缺 Settings 入口且按钮顺序与规格不符（`frontend-spec.md:119-125`）；Terminal 默认高度 280px 非"对话列 35%"（`frontend-spec.md:417`）；记住的规则缺规格要求的"来源 call"展示（`frontend-spec.md:475`，`UiRememberedRule` 无该字段）；"批准并记住"成功无即时反馈（`frontend-spec.md:697`）。

**UI 细节**：GoalPanel 不展示 `requiredInput`（blocked 时用户只看到干标签）且无任何操作入口；工具结果 envelope 原始 JSON 直出、`truncated/totalBytes` 暴露为内容而非截断提示横幅；消息流无时间戳；startPending 窗口无 loading 也不能取消；`interruptRun` 返回 `accepted=false` 时无反馈；多个终端 tab 同名（3 个 zsh）不可区分；TerminalPanel 的 error 通知因不重置而对同值去重失灵；Diff 过滤视图下详情面板仍可对不可见项执行 revert；归档恢复零反馈且无"打开对话"入口；敏感数据/日志/助手偏好三处保存无脏状态无"已保存"反馈；Token 估算同时存在于 Provider 卡片与 Limits 页、草稿可互相覆写；webSearch Key 的 placeholder 逻辑反了（未配置时为空、已配置才提示）；终端字体栈 Windows 取向（macOS 落到通用 monospace）；长首条消息产生 256 字符超长标题（`durable-run-application-service.ts:430-433`，建议收敛 ~50 字符）。

**死代码/文档脱节**：`modeSyncError` 恒返回 `''` 的死 stub（`agent-runtime.ts:261-263`）；一批死 i18n key（`chat.approvalHint`/`chat.eventGap`/`chat.requestFailed` 等）；WebSearch 是已发布功能但 `requirements.md`/`frontend-spec.md` 完全未提及（文档脱节，建议补记）；Settings 形态为整页视图而非规格要求的 modal tab（`frontend-spec.md:434`，规格未同步）；侧栏 import/export 永久禁用占位按钮——注意 `requirements.md:386` 明确要求保留禁用按钮，不算违规，但 tooltip"待 Durable Session 导入/导出重设计"是开发黑话，建议换面向用户的说法。

**交付形态**：卸载静默保留全部用户数据含凭据（`electron-builder.json5:29`，建议卸载器提供"删除用户数据"选项）；首启 locale 固定 zh-CN 不检测 `navigator.language`；`second-instance` 只聚焦窗口丢弃 argv（未来"以…打开"需转发）；headless CLI 无 `--help`、5 参数全必填；**macOS 地雷**：`main.ts:417` `Menu.setApplicationMenu(null)` 在 macOS 会移除 Edit 菜单导致 Cmd+C/V 失效——当前只发 Windows 无影响，但 `requirements.md:517` 已列 macOS 计划，届时必踩。

### 9.5 产品面做得好的地方

- **审批与通知体系规格兑现度最高**：ApprovalCard 完整覆盖 args/reason/policySignals/diff/scope/expiry/remember，提交后按钮幂等禁用，diff/args 全走文本绑定；通知严格兑现 §11（warning 10s、error 常驻、5 条排队、三元组去重、后台会话带标题前缀），且后端通知统一脱敏。
- **消息级操作闭环完整**：重试/编辑/回退/分支均有 tooltip、二次确认、消息预览、busy 禁用；归档→恢复→永久删除整条会话生命周期自洽；插话 queued/injected/superseded/carryover 四态对用户透明。
- **安全默认值取向正确**：Skills 默认禁用 + hash 变化自动失信；MCP 指纹信任 + trust 弹窗 env 脱敏；providerNotice/yoloNotice 版本化告知确认；失败路径保留用户输入草稿。
- **健壮性超出规格的点**：终端切换后 scrollback 快照恢复 + 输出缺口检测；revert 的 after-hash 校验拒绝覆盖更新的工作 + 原子写可跨重启；headless 退出码语义完整（0/2/3/4/5/130）+ artifacts 契约 e2e 覆盖；i18n 540/540 key 完全对齐且切换同步主进程。
- **两个点名问题的核实结论**：会话标题**不是**永远默认标题——实际取首条用户消息截断（`durable-run-application-service.ts:292,430-433`），`conversation-titles.ts` 死代码不影响显示；应用内搜索**存在**且为纯本地 SQLite 查询，符合规格，缺口仅在不能定位到具体消息（见 §9.3）。

### 9.6 产品面修复优先级建议

**第一梯队（功能失效/误导用户，均为小改动）**：P1（webSearch `v-model`）、P2（read-only locked 流程）、P3（默认模式解耦）、P4（首用 Send 禁用+引导）、P5（审批失效态+OS 通知）、P6（终端关闭确认），以及工具卡成败着色、批准计划去伪造用户消息——全部建议配套补回归测试（P1/P2/P3 当前零覆盖）。
**第二梯队（状态诚实性批次）**：compaction 可见性、取消留痕、Writer/locked badge 接通死键、错误码结构化 + 可行动通知、成功/完成通知通道、run 耗时显示。
**第三梯队（机制可理解性）**：remember rule 语义说明、四模式解释文案、MCP 配置入口引导、Provider 表单字段级校验、trace 独立告知。
**第四梯队（发布闭环与打磨）**：自动更新/版本可见性、窗口持久化、启动骨架屏、i18n 漏洞群、规格未兑现打磨项（§9.4），并同步更新 frontend-spec（Settings 形态）与 requirements（WebSearch 能力）两处文档脱节。
