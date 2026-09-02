# Unreleased

本次更新移除应用自有的文件 Diff/恢复体系，改为直接查看当前 Project 的 Git 状态，并统一文件写入基础设施。

## 升级说明

- SQLite 会迁移到 v11，并永久删除旧 `file_changes`、恢复快照和 retention 状态。升级前如需保留旧的应用内变更记录，请先自行查看；升级后文件恢复完全依赖用户自己的 Git 历史、stash 或其他备份。
- AppConfig 会迁移到 v26，删除 `limits.diffChars`、`limits.fileChangeHistoryBytes`，并移除旧 `create_file` remembered approval rule。其他 Provider、权限和运行配置保持不变。
- 模型文件工具由 `create_file` 改为 `write_file`。旧对话中的 `create_file` 调用仍可阅读，但不再是可执行工具，也不会把旧授权自动扩大到覆盖写。
- Headless result 升为 schema v2，不再返回 `patchPath/patchStatus`，也不生成 `workspace.patch`。依赖这些字段的调用方需要改为直接检查工作树或 Git。

## 文件工具与 Git Review

- `write_file` 可以创建或整体覆盖 UTF-8 文件，并在覆盖时保留当前 permission mode；缺失父目录会自动创建。
- `apply_patch` 在执行时读取最新文件，只在每个上下文序列精确且唯一匹配时写入；缺失或歧义会保持文件不变并要求重读。
- `delete_file` 不读取待删除内容，可直接删除大二进制；重复删除幂等返回 `deleted: false`。
- 文件审批只展示工具、完整参数、原因和风险信号，不再生成预览 Diff 或绑定文件快照。并发文件写入采用 last-writer-wins。
- 右侧 Diff tab 现在是 Project 级实时 Git Review，可查看相对 `HEAD`、unstaged、staged 和 merge-base 的变化。未跟踪文件显示 status，二进制只显示 Git marker，不生成 binary patch。
- Session rewind、retry、edit 和 fork 只修改对话，不再回滚文件。应用不按 Session、Run 或 Agent 保存、归因或恢复工作树变更。

## 已知限制

- 非 Git Project 没有 Diff 内容或应用级文件恢复能力。
- Git Review 会显示 Project scope 内来自用户、Terminal、Agent 和外部程序的混合变化；它不提供来源归因。
- 未跟踪文件在加入 Git 前没有标准 Git Diff。
- 同时基于同一旧内容发布的写入可能互相覆盖；需要隔离时请使用 Git branch/worktree 或外部协调。
