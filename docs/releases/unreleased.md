# Unreleased

本次更新移除应用自有的文件 Diff/恢复体系，改为查看 Project 的 Git 状态，并统一文件写入、项目共享产物与 Desktop/Headless profile。

## 升级说明

- SQLite 会迁移到 v13：v12 删除旧 `file_changes`、恢复快照和 retention 状态，v13 增加项目产物元数据。已经执行过历史 `11:0011_background_task_public_ids` 的开发数据库会按精确 checksum 兼容并由 v12 收敛，不需要删除或重建数据库。升级前如需保留旧的应用内变更记录，请先自行查看；升级后文件恢复完全依赖用户自己的 Git 历史、stash 或其他备份。
- AppConfig 会迁移到 v26，删除 `limits.diffChars`、`limits.fileChangeHistoryBytes`，并移除旧 `create_file` remembered approval rule。其他 Provider、权限和运行配置保持不变。
- 模型文件工具由 `create_file` 改为 `write_file`。旧对话中的 `create_file` 调用仍可阅读，但不再是可执行工具，也不会把旧授权自动扩大到覆盖写。
- Headless result 升为 schema v2，不再返回 `patchPath/patchStatus`，也不生成 `workspace.patch`。依赖这些字段的调用方需要改为直接检查工作树或 Git。
- Electron main 与 Headless 的 ESM 构建会保留对 CommonJS `write-file-atomic` 的原生运行时加载，避免内联后因缺少 `__filename` 导致启动失败。

## 项目短根与共享数据库

- 同项目的任务共享原生 `workspace/tmp` 入口，command、文件工具、Terminal 和 manifest 使用同一地址；产物目录以项目内按类型持久自增的编号命名。
- SQLite v13 增加项目根、序列、产物注册表与旧路径映射。已有完整输出经登记和复制校验导入，旧原生地址及工具 alias 保持兼容，fork 同名引用要求明确原生路径。
- 捕获写入全部结束后保留 24 小时，按产物清理；活跃捕获、scratch 和其他任务活动不影响这一期限。
- Desktop/Headless 共用 `<profileData>/agent.db`，支持 `--profile-dir` 和 `ZCH_PROFILE_DIR`；同 profile 被占用时返回 `PROFILE_IN_USE`，先支持轮流运行。Headless 本次配置不改写 Desktop 设置，导出索引仅列当前任务的产物。
- 对话 Markdown 搜索投影仍未实施。

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
