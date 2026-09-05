# 持久化与文件系统决策

本文按主题保存历史决策。每条日期是决定发生时间，状态和后续替代条目共同解释适用范围；当前规则见[架构总览](../architecture.md)。返回[决策索引](../decision-log.md)。

## 2026-09-03 — 精确兼容已经执行的 SQLite v11 分叉迁移

- 状态：已采纳并实现。开发数据库中已经存在 `11:0011_background_task_public_ids`，而当前标准 v11 是 `0011_remove_file_changes`；两者占用了同一不可重写的 migration version。
- 决定：标准新数据库继续执行 `0011_remove_file_changes`。migration runner 只接受名称为 `0011_background_task_public_ids` 且 SQL checksum 精确等于历史值 `771c64e…d9cb` 的 v11 alternative；任何其他名称或 checksum 仍 fail closed。
- 收敛：SQLite v12 `0012_reconcile_file_change_removal` 幂等删除 FileChange 表与 retention trigger，并移除历史 v11 创建的 `subagent_executions_require_public_id` trigger，使当前不写 `public_id` 的 Subagent repository 能继续工作。历史 auxiliary table/column 保留为无消费者数据，不在启动修复中破坏性重建业务表。
- 理由：修改用户数据库 ledger、放宽任意 checksum 或删除数据库都会破坏 durable backend 的可信边界。显式列出一个可审计的历史 alternative，并通过下一号迁移收敛当前必须满足的 schema，既保留严格校验，也兼容已经落盘的开发数据。

## 2026-09-02 — 删除应用自有 Diff 与文件恢复，改用实时 Git Review

- 状态：已采纳并实现；本条完整取代 2026-09-01“FileChange 回退改用 Git reverse patch”，并取代所有仍要求 FileChange、审批 Diff、Run checkpoint、patch retention 或应用级文件恢复的旧决策。
- 文件恢复：应用不记录 Run 开始状态，也不记录每次文件工具的 before/after、Diff、patch、hash、mode 或恢复元数据；不提供单项或整 Run undo。Session rewind/retry/edit/fork 只修改对话。无论 Project 是否为 Git repository，恢复工作树都由用户直接使用 Git 或其他外部工具完成。
- 数据与兼容：标准 SQLite v11 删除 `file_changes`、retention state 和 triggers，v12 对历史 v11 分叉执行同一幂等收敛；AppConfig v26 删除 `diffChars/fileChangeHistoryBytes` 并移除旧 `create_file` remembered rules；Headless result v2 删除 `patchPath/patchStatus`，不再生成 `workspace.patch`。`apply_patch` 的参数仍可作为 canonical tool-call Message 保存，但它不是恢复副本或 Diff history。
- 前端语义：原 Diff tab 改为 Project 级实时 Git Review，按需查询 status，以及相对 `HEAD`、index、staged `HEAD` 或所选 ref merge-base 的有界 Diff。未跟踪文件只有 status，二进制只有 marker；结果不归因于 Session、Run、Agent 或工具调用，不进入 SQLite 或 durable event。
- 理由：Git 已经是代码项目的版本控制真相源。继续维护第二套 FileChange/patch/revert 状态既无法覆盖 Terminal、用户和外部进程，又会给大二进制删除、并发归因、retention 和迁移增加成本。只读 Git Review 保留日常审查能力，同时彻底移除恢复一致性问题。
- 接受的代价：非 Git Project 没有 Diff 面板内容或应用级恢复；Git Review 会混合当前 Project scope 内的所有来源变更；untracked 文件在加入 Git 前没有标准 Diff；last-writer-wins 仍可能覆盖基于同一旧内容的并发写入。

## 2026-09-01 — Main process 文件能力统一归 `electron/common/filesystem`

- 状态：已采纳并实现；实施记录见 [文件系统与文件工具重构记录](../archive/file-tools-filesystem-refactor-plan.md)。
- 决定：通用文件读取、检查、目录创建、原子 text/buffer/JSON 替换、权限继承、幂等删除和临时文件清理统一由 `electron/common/filesystem` 的单一出口提供。目标状态下，除该 package 和测试 fixture 外，`electron/**` production code 不直接导入 `node:fs`/`node:fs/promises`，并由架构测试固定。
- 实现边界：原子替换由 common facade 封装 `write-file-atomic`，第三方 API 不泄漏给业务模块；覆盖现有文件继承 permission mode，新文件服从进程 umask。owner/ACL/xattr 不作为跨平台产品承诺。filesystem common 不拥有 PathGuard、审批、Tool schema、Git 或 SQLite 事务。
- 理由：当前 config、tool、FileChange、headless、session-temp 和 skills 分别实现临时文件与 rename，权限保持、清理、Windows 行为和耐久性修复无法一次覆盖。`shared/` 必须保持 Node-free，`tooling` 只拥有 Tool framework，因此 Main-only 的 `electron/common/filesystem` 是合适边界；统一入口也比继续在每个业务 package 维护局部 helper 更易测试和替换。

## 2026-09-01 — 文件工具采用 best-effort 与 last-writer-wins

- 状态：已采纳并实现；本条取代 2026-08-26 并发决策中继续保留文件 precondition/FileChange OCC 的部分，以及审批后文件变化必须使调用失效的旧要求。
- 工具集合：`create_file` 替换为 `write_file`。不存在则创建，存在的普通文件则整体覆盖；覆盖保留当前权限，新文件使用正常 workspace 默认权限。旧 canonical history 中的 `create_file` 仍按历史事实显示，但生产 catalog 不保留 alias，旧 remembered rule 也不自动扩大为 `write_file` 授权。
- 审批语义：批准继续绑定 tool/call 和完整 args hash，并在审批前与执行时校验 path/scope；不生成审批 Diff。目标内容、hash、inode、mtime、父目录 identity 或预期结果在批准后变化，不再作为执行拒绝条件。执行时仍重新经过 PathGuard，symlink/junction、目录、越界和非法根继续失败。
- 执行语义：`apply_patch` 重新读取最新内容，只在精确上下文唯一匹配时应用；缺失或歧义零写入并要求 Agent 重读，不做 fuzzy replacement。`delete_file` 重新解析普通文件后删除，不检查旧 hash；不存在时幂等成功并返回 `deleted: false`。读取后的并发写入允许由最后完成的写入覆盖，产品不提供 workspace writer lock 或自动 merge。
- 理由：多人/多 Agent 并发本来无法由审批时快照彻底解决；当前条件写把用户授权和 OCC 混成一个机制，增加复杂度并制造大量无价值的 `RESOURCE_CHANGED`。保留参数与路径授权、原子发布和明确冲突错误，已经足以表达本地 coding agent 的实际承诺。

## 2026-09-01 — FileChange 回退改用 Git reverse patch

- 状态：未实施，已由 2026-09-02“删除应用自有 Diff 与文件恢复”完整取代；以下只保留决策演进背景。
- 决定：FileChange 继续持久化 Session/tool-call 归属与实际 Diff，但 backend 不再保存 `beforeContent`、before/after hash 或自研恢复 payload。新记录保存完整 Git-compatible forward patch；回退只对 working tree 执行等价于 `git apply --reverse` 的 Git 操作，不触碰 index，不创建 commit/stash/ref，不使用 `git restore`、`git checkout` 或面向 commit 的 `git revert`。
- 冲突语义：Git 无法反向应用时返回 `CONFLICT` 并保持 workspace 原状；不使用 `--3way`、`--reject`、fuzzy merge 或整文件覆盖 fallback。非 Git workspace 仍可查看 Diff 历史，但 Revert 明确不可用。旧 v1 FileChange 迁移为 `legacy_unavailable` 只读历史，并删除私有恢复快照。
- 一致性取舍：FileChange 变为文件 mutation 成功后的 best-effort annotation。patch/SQLite retention 或持久化失败不会阻止、撤销或自动重试已经授权的文件操作；结果必须如实报告 `mutationSucceeded: true`、warning 和 `revertAvailable: false`。Git 只替代内容恢复/冲突算法，Session 归属、patch retention、revert command 和状态持久化仍由应用负责。
- 理由：Git 的反向 patch 可以在上下文仍匹配时保留无关修改，并在重叠修改时确定性拒绝；它比持久化整份 before snapshot 和维护第二套恢复算法更符合项目的简化方向。接受的代价是非 Git 项目没有回退、乱序回退可能冲突，以及 Git 可执行文件成为该能力的前提。

## 2026-07-25 — FC-1：FileChange revert 的 workspace TOCTOU

- 状态：FileChange revert 已由 2026-09-02 决策彻底删除；对普通文件工具路径检查与最终系统调用之间的同机竞争风险仍接受。
- 决定：本轮不引入基于目录句柄的 no-follow 原子文件操作。
- 背景：`FileChange` 回滚会在完成路径与内容校验后，以字符串路径调用最终的 `rename` 或 `unlink`。外部本地进程若在极窄窗口内替换文件或中间目录，可能覆盖竞争方的新内容；若以符号链接或等效机制替换中间目录，理论上还可能越过 workspace 边界。原 FC-1 review 文档已不在当前仓库；本条保留其风险描述与处理决定。
- 理由：完整修复需要跨平台目录句柄绑定和 no-follow 原子操作，实施复杂度高；当前产品假定本地 workspace 和同机进程可信，接受极窄外部竞争窗口。Durable Backend 切流不改变这一取舍。
- 当前语义：应用没有文件回滚路径。普通文件工具仍在审批与执行时重新执行 PathGuard，但最终路径系统调用存在极窄的外部竞争窗口；workspace 边界是面向受信本机环境的 best-effort，不是 OS sandbox。
- 重新评估条件：支持不可信插件/同机竞争方、更高权限运行环境，产品承诺升级为强文件系统隔离，或具备可用的跨平台句柄式文件操作实现。

## 2026-07-25 — FC-3：FileChange beforeHash 不交叉校验

- 状态：已由 2026-09-02 删除 FileChange 的决策完整取代；以下只保留历史背景。
- 决定：Revert 继续信任同一 SQLite record 中的 `beforeContent`，不在读取时重新计算并强制匹配 `beforeHash`。
- 理由：记录由单一 backend transaction 写入，正常路径不存在两者分叉；触发需要数据库损坏或外部篡改。异常仍进入现有 codec/SQLite/revert 诊断日志，暂不增加 hash 交叉校验与恢复拒绝分支。
- 重新评估条件：支持外部导入 FileChange、数据库修复工具、跨设备同步，或出现真实损坏案例。

## 2026-07-26 — FileChange Assistant Message ID 保持软关联

- 状态：已由 2026-09-02 删除 FileChange 的决策取代；SQLite v12 已保证删除对应表和关联字段，以下只保留历史背景。
- 决定：`file_changes.assistant_message_id` 继续作为工具批次的关联标识，不要求对应 `messages` 行已经或最终成功提交。
- 理由：文件副作用完成后，FileChange 审计会先于整个 Assistant/tool batch 的 Session commit 独立写入。若后续 Session commit 失败，审计仍必须保留；外键会使审计写入失败或迫使运行时错误地提前提交 Assistant 消息。现有 `UNIQUE (session_id, assistant_message_id, call_id, path)` 已提供以 Session 和 Assistant Message ID 为前缀的复合索引。
- 重新评估条件：FileChange 与 Session message 改为同一事务提交，或产品要求按 Assistant Message ID 跨 Session 独立查询。

## 2026-07-26 — PersistenceReader 采用明确的 no-write 契约

- 状态：接受约束，不增加 query authorizer。
- 决定：`DatabaseService.read()` 回调和 `PersistenceReader` 只允许执行查询；所有 durable 写入必须进入 `withTransaction()` 并使用 `PersistenceTransaction`。代码注释明确说明 SQLite 本身不会强制该限制，不把 facade 描述成技术上只读。
- 理由：当前所有 reader 调用点均为受控 repository 查询，额外为每次 query 切换 SQLite authorizer 会增加全局连接状态和嵌套调用复杂度。项目更看重清晰的 repository 契约和 review 门禁，而不是对内部受信代码做运行时 SQL 分类。
- 已知代价：未来代码若违反契约，可通过 `reader.prepare()` 执行写 SQL，从而绕过事务队列、cursor 和 commit 发布。这属于代码审查可发现的内部误用，不是面向不可信输入的安全边界。
- 重新评估条件：开放第三方 repository/plugin、出现实际误写，或 SQLite 连接拆分为独立 read/write handles。

## 2026-07-25 — M-1：FileChange 预写失败时禁止文件副作用

- 状态：已由 2026-09-02 删除 FileChange 的决策完整取代；以下保留为历史背景。
- 决定：文件变更工具必须先完成 `prepareMutation`；包括 SQLite 错误在内的任何准备失败都会跳过文件写入并让当前 Run 失败，前端向用户显示错误并允许重试请求。
- 理由：如果审计记录尚未可靠准备就继续修改文件，会产生无法证明、无法安全回退的副作用。相较于把数据库短暂故障降级为 warning，请求失败更符合 Durable Backend 对变更可追溯性的承诺。
- 边界：文件写入已经成功后，`commitMutation` 失败仍保留现有 warning 语义，因为此时再把 Run 标为失败并不能撤销已发生的文件副作用；工具结果必须明确 `mutationSucceeded: true` 和回退不可用。
