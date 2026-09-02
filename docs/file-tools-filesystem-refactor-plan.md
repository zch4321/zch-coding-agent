# 文件系统、文件工具与 Git Review 重构记录

- 状态：已实施
- 决策日期：2026-09-01～2026-09-02
- 实施分支：`refactor/git-native-diff-view`
- 范围：Main process 文件基础设施、内置文件工具、审批、Git 变更查看、SQLite 与 Headless 输出

## 1. 最终决策

应用不再维护任何自有 Diff、patch history 或文件恢复能力。

- 不记录 Run 开始时的文件状态，也不记录每次工具调用的 before/after、Diff 或 patch。
- SQLite 不保存 patch 正文、内容快照、hash、mode 或 FileChange 元数据。
- Session rewind、retry、edit 和 fork 只改变对话历史，不改变 workspace。
- 应用不提供单文件或整 Run 回退。需要恢复时，由用户直接使用 Git。
- Renderer 的“变更”面板是 Project 级 Git 工作树查看器，不再表达 Session、Run、Agent 或工具调用归属。
- Headless 不再生成 `workspace.patch`，结果契约也不返回 patch path/status。

这里的“删除 patch”不包括 `apply_patch` 工具参数。`apply_patch` 仍是模型提交聚焦文本编辑的输入协议；应用只在本次调用内解析和应用它，不持久化或展示为自有历史。

## 2. 为什么不保留 FileChange

FileChange 曾同时承担审批预览、审计历史、恢复载荷和前端 Diff 数据源，导致四类问题：

1. 同一份文件状态被 Git 与应用数据库重复维护，一致性边界不清晰。
2. 二进制删除需要额外特判，否则可能为了“可恢复”复制大文件或生成无意义 payload。
3. Session/Run 归属无法准确涵盖用户、Terminal、外部工具和多个 Agent 对同一工作树的混合修改。
4. 审批时快照被误用为乐观并发控制，正常的并行编辑频繁触发 `RESOURCE_CHANGED`。

最终选择把职责拆开：审批只决定“是否允许用这些参数操作这个路径”，Git 负责版本控制，Git Review 只查询当前状态。没有 Git 的项目仍可编辑，但不提供变更面板能力或回退承诺。

## 3. Main process filesystem 边界

通用宿主文件能力统一从 `electron/common/filesystem/index.ts` 导出：

```text
electron/common/filesystem/
  index.ts
  errors.ts
  inspect.ts
  read.ts
  atomic-write.ts
  remove.ts
  directory.ts
```

- `write-file-atomic` 只在该 package 内使用。
- 覆盖普通文件时保留执行时的 permission mode；新 workspace 文件服从进程 umask。
- Config/secret 类调用可显式要求 `0600`，不继承意外放宽的旧 mode。
- 同路径的进程内原子写由库串行；外部进程不参与队列。
- production `electron/**` 在 common package 外不得直接导入 `node:fs` 或 `node:fs/promises`，由 architecture test 固定。
- PathGuard、审批、工具 schema、Git 与 SQLite 不属于 filesystem common。

## 4. 文件工具语义

生产 catalog 只提供 `write_file`、`apply_patch` 和 `delete_file`。历史 Message 中的 `create_file` 保持原样可读，但不再有可执行 alias；AppConfig v25→v26 会删除对应 remembered approval rule。

### 4.1 共同边界

- schema 和 args hash 绑定完整批准参数，模型不能在审批后替换 path/content/patch。
- 审批前与执行时都重新经过 workspace/Session scratch PathGuard。
- symlink、junction、目录、越界路径和 application-owned artifacts 继续拒绝。
- 审批卡展示工具名、原始参数、理由和 policy signals，不生成 Diff 或 `diffHash`。
- 大文件风险基于输入、当前文件和结果的字节元数据判断，不读取被删除的二进制内容来生成预览。

### 4.2 `write_file`

- 目标不存在时创建，并创建缺失父目录。
- 目标是普通文件时整体覆盖。
- 覆盖保留执行时 mode；新文件使用正常默认权限。
- 审批后目标被创建、替换或编辑不会让调用自动失效。

### 4.3 `apply_patch`

- 只接受单文件 UTF-8 unified diff，不接受 create/delete、binary、rename 或 mode change。
- 执行时重新读取最新内容。
- 每个 hunk 的 context/deleted 序列必须在当时内容中精确命中一次。
- 无命中或多处命中均零写入，并返回 `INVALID_PATCH`；不使用 header 行号绕过歧义，不做 fuzzy/3-way merge。
- 成功结果只返回 hunk 与增删行统计、最终 content hash，不保存 patch。

### 4.4 `delete_file`

- 删除普通文件，不读取内容，也不受文本编辑大小上限约束。
- 目标已不存在或在删除竞态中消失时成功返回 `{ deleted: false }`。
- 因而删除 100 MB 二进制文件不会生成或保存 100 MB payload。

### 4.5 并发承诺

文件工具采用 best-effort/last-writer-wins，不提供 workspace writer lock 或 compare-and-swap。两个调用若先后读取，后一个会基于前一个结果继续应用；若两个外部并发调用恰好都读到同一旧内容，再分别原子替换同一文件，最后完成者可能覆盖先完成者，即使两个逻辑 patch 不冲突。产品明确接受这一点，不把本地工作树包装成协同编辑系统。

## 5. Git Review

Renderer 通过独立只读 IPC 查询 Project，不调用模型 Tool Registry：

- `git-review:get-status`
- `git-review:get-diff`

状态查询返回 repository、top-level、HEAD ref/OID、upstream、可选 base refs，以及 porcelain status entries。具体 Diff 在用户选择路径后懒加载，输出有 timeout 和 byte bound，并禁用 pager、颜色、external diff 和 textconv。

支持四种基准：

- `head`：working tree 与当前 `HEAD` 比较，包含 staged 与 unstaged 的合并结果。
- `unstaged`：working tree 与 index 比较。
- `staged`：index 与 `HEAD` 比较。
- `merge_base`：先解析所选 ref 与 `HEAD` 的 merge-base OID，再将当前 working tree 与该 OID 比较。

未跟踪文件出现在 status 列表中，但在加入 Git 前没有 Git Diff；UI 明确显示这一点。二进制 Diff 只显示 Git 的 binary 标记，不请求 `--binary` payload。detached HEAD、unborn HEAD、无 merge base、浅克隆缺失历史和 Git 不可用均返回明确状态或错误，不创建 fallback Diff。

该视图反映 Project 当前工作树，可能混合用户、Terminal、多个 Agent 和外部程序的修改；不会声称某项变更属于当前 Session 或 Run。用户可手动刷新，内置工具完成后 Renderer 也会触发刷新。

## 6. 迁移与兼容

- SQLite migration `0011_remove_file_changes.sql` 删除 FileChange retention triggers、`file_change_retention_state` 和 `file_changes`。
- 旧 migration 文件不可改写；新安装最终 schema 同样不含这些表。
- shared domain、IPC、preload API、Backend service/repository、runtime execution port、renderer replica/store 和恢复 UI 全部删除。
- AppConfig 升为 v26，删除 `limits.diffChars` 与 `limits.fileChangeHistoryBytes`，并过滤旧 `create_file` remembered rules。
- Headless result 升为 schema v2，删除 `patchPath`/`patchStatus`。
- 日志与 transcript 不记录 `diffHash`；工具参数仍按现有 trace privacy 规则记录。

## 7. 验证重点

- architecture test：common 外无 production Node filesystem import。
- 文件工具：覆盖写、mode 保留、缺失父目录、审批后 latest-content patch、歧义零写入、last-writer-wins、取消、100 MB binary delete 与重复 delete。
- Git Review：非 Git、tracked/untracked、staged/unstaged、rename、binary、unborn/detached HEAD、Project 子目录 scope、merge-base working-tree 比较与 IPC 转发。
- migration：旧 FileChange 表被删除，AppConfig v25 字段与授权规则被清理。
- contract：Agent API、IPC、PublicConfig 和 Headless result schema 明确更新。

## 8. 已知限制

- 非 Git 项目没有 Diff 面板能力，也没有应用级恢复。
- Git Review 不按 Session/Run/Agent 归因。
- 未跟踪文件只有 status，加入 index 前没有标准 Git Diff。
- 大仓库状态和 Diff 会被输出上限截断；UI 显示截断标记。
- last-writer-wins 可能覆盖同时基于同一旧内容完成的非冲突编辑；需要更强协作语义时应由 Git 分支/worktree 或外部协调机制解决。
