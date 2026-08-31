# 文件系统与文件工具重构计划

- 状态：设计已采纳，尚未实施
- 日期：2026-09-01
- 范围：Main process 文件基础设施、内置文件工具、审批语义、FileChange 与 Diff/Revert

## 1. 背景与目标

当前项目在 `electron/config`、`electron/tools`、`electron/application`、`electron/headless`、`electron/session-temp` 和 `electron/skills` 等目录分别实现了临时文件、原子替换、清理和文件状态读取。文件工具又把审批时的文件 identity/hash、父目录 identity、预期结果 hash 和 FileChange 恢复快照绑定为一套 conditional mutation。这些实现解决过特定问题，但产生了三个新的系统性成本：

1. 通用文件能力没有单一所有者，修复权限保持、临时文件清理或耐久性问题时需要修改多份实现。
2. 文件审批同时承担“用户授权动作”和“乐观并发控制”两种职责；本地用户或其他 Agent 的正常编辑会让已批准调用失效。
3. FileChange 自己保存 `beforeContent` 并实现文件恢复，重复实现了 Git 已有的补丁反向应用与冲突判断。

本次重构采用以下目标：

- Main process 的项目文件访问统一经过 `electron/common/filesystem`。
- 文件工具采用 best-effort、last-writer-wins 语义，不再把审批时快照作为执行前置条件。
- `create_file` 替换为可创建也可覆盖的 `write_file`。
- `apply_patch` 只做精确、唯一上下文匹配，不做 fuzzy replacement。
- `delete_file` 对不存在目标幂等成功。
- FileChange 保留 Session/tool-call 归属与 Diff 历史，但回退算法依赖 Git reverse patch；删除 `beforeContent` 和非 Git 恢复 fallback。

## 2. 非目标与仍然保留的边界

放宽并发语义不等于取消文件安全边界。本次不改变以下约束：

- 参数 schema、文件大小、补丁大小、输出大小和超时仍然有界。
- `PathGuard` 继续限制 workspace 和当前 Session `scratch`，拒绝越界路径、符号链接、junction、目录和其他非普通文件；`artifacts` 仍只读。
- Readonly、Auto、Confirm、Yolo、危险路径、VCS metadata、敏感文件和人工审批策略继续生效。
- 审批继续绑定不可变的 tool id、call id、完整 args hash、规范化目标路径和操作类型；模型不能在批准后替换参数或目标。
- 原子写只保证不会向读取者暴露半个文件，不提供 compare-and-swap、跨进程锁或“无人覆盖我的修改”承诺。
- 不引入 fuzzy patch、自动 merge、冲突标记、隐藏 commit、stash 或每次工具调用一个 commit。
- 不使用 `git restore`/`git checkout` 覆盖整个文件，也不使用面向 commit 的 `git revert`。
- 不承诺抵御同机恶意进程在路径检查与系统调用之间制造的 descriptor-level TOCTOU；需要该承诺时应单独设计 OS sandbox/no-follow handle 方案。

## 3. 目标代码边界

```text
electron/
  common/
    filesystem/
      index.ts             # 唯一公开入口
      errors.ts            # ENOENT/EEXIST 等稳定错误归一化
      inspect.ts           # lstat/realpath/普通文件与 mode 状态
      read.ts              # text/buffer/bounded/handle 读取原语
      atomic-write.ts      # text/buffer/JSON 原子替换
      remove.ts            # 幂等文件删除与受控目录清理
      directory.ts         # mkdir/readdir 等目录原语
  git/
    client.ts              # argv-only、bounded、abortable Git 进程入口
    patch-service.ts       # 仓库探测、Git-compatible patch 与 reverse apply
  tooling/                 # ToolDefinition/registry/executor/projection 框架
  tools/                   # 内置 Tool schema、描述与薄业务 adapter
  safety/path-guard.ts     # workspace/session-temp 授权与路径安全
  application/             # FileChange 编排和持久化事务
```

依赖方向固定为：

```text
application / config / logging / tools / safety / session-temp
                         |
                         v
             electron/common/filesystem
                         |
                         v
                   Node filesystem

FileChangeService -> electron/git/patch-service -> process runner
file tools        -> PathGuard + permission -> common/filesystem
```

### 3.1 `electron/common/filesystem` 的职责

- 封装 Node/Electron Main process 可复用的文件读写、原子替换、权限继承、目录创建、幂等删除和临时文件清理。
- 统一错误分类、AbortSignal 检查和 Windows/POSIX 差异。
- 通过小模块实现，在 `index.ts` 形成单一 import surface；`common` 不是一个大文件。
- 原子替换由该 facade 封装 `write-file-atomic`。覆盖已有文件默认继承 permission mode；新文件不指定固定 `0600/0644`，使用进程 umask 下的正常默认权限。owner/ACL/xattr 不作为跨平台产品承诺。依赖版本必须同时兼容开发 Node 和 Electron 内置 Node。
- 同进程对同一路径的原子写按调用顺序串行；不同路径可以并行。外部进程不参与该队列，最终内容仍由最后完成的写入决定。
- 第三方库只允许在该目录直接导入，业务模块不得依赖其 API，便于以后替换实现。

### 3.2 明确不属于 filesystem common 的职责

- `shared/` 继续保持 process-neutral、Node-free，因此不能承载 `node:fs` 实现；`electron/tooling` 只拥有 Tool framework，也不应拥有通用宿主文件基础设施。这是选择 `electron/common/filesystem` 而不是 `shared/`、`electron/util` 或 `electron/tooling` 的原因。
- workspace、Session temp、`scratch`/`artifacts` 的授权属于 `PathGuard`。
- 是否需要审批、风险级别与 remembered rules 属于 permission pipeline。
- UTF-8 patch 解析、Tool schema 和模型结果属于 `electron/tools`。
- FileChange 归属、retention、SQLite transaction 和 revert command 属于 application/persistence。
- Git 仓库发现和补丁执行属于 `electron/git`，不塞进 filesystem facade。

### 3.3 统一入口门禁

目标状态下，`electron/**` 的 production 文件不得在 `electron/common/filesystem/**` 之外直接导入 `node:fs` 或 `node:fs/promises`。数据库 driver、Git/子进程自身的内部 I/O 以及测试 fixture 不计入该规则。架构测试应扫描生产 import；迁移期间只允许一份逐步缩小的显式 allowlist，完成后删除 allowlist。

## 4. 文件工具的目标语义

共同执行流程为：

```text
schema/permission plan
  -> 展示当时的有界预览并取得审批
  -> 执行时重新解析目标和根目录
  -> 读取执行时最新状态
  -> best-effort mutation
  -> 根据本次调用实际读取的 before 与其发布/删除的结果生成 patch
  -> 尽力持久化 FileChange
```

审批 Diff 是帮助用户判断风险的时间点预览，不是后续 compare-and-swap 条件。审批之后文件发生变化不会自动使批准失效。落盘后的 Diff 历史必须来自本次调用实际读取的 before 与其发布/删除的结果，不能把过时审批预览冒充实际结果；它描述该工具调用，不承诺在外部 last writer 完成后仍等于 workspace 当前总 Diff。

### 4.1 `write_file`

`create_file` 从 Provider catalog、Tool Registry 和 prompt 中移除，由 `write_file` 替代：

- 目标不存在时创建文件，并递归创建缺失父目录。
- 目标是允许范围内的普通文件时整体覆盖。
- Tool description 与审批卡始终写明“创建或覆盖”；不能因为审批预览时不存在就把授权描述成只允许 create。
- 审批前后或执行期间目标被其他调用编辑过，不因旧 existence/hash/file identity 拒绝。
- 覆盖现有文件时保留当前文件权限；创建新文件时使用正常 workspace 默认权限。
- 输入内容仍受 `writeFileBytes` 限制，写入仍使用同目录临时文件和原子替换。
- 成功结果至少区分 `created: true|false`，并返回本调用写入内容的 hash。

旧 canonical history 中的 `create_file` 调用和结果按历史事实继续显示，不改写 Message。生产 catalog 不保留可执行 alias。旧 `create_file` remembered approval rule 不自动迁移到权限更大的 `write_file`，避免把“只创建”授权静默扩大为“可覆盖”。

### 4.2 `apply_patch`

- 执行时重新解析并读取最新 UTF-8 普通文件，不使用审批时的内容快照。
- hunk header 的行号和行数仍只作定位提示；上下文行和删除行必须逐字精确匹配。
- 原位置不匹配时，只允许在最新内容中找到一个精确且唯一的上下文位置后应用。
- 无匹配返回 `PATCH_CONTEXT_NOT_FOUND`；多个精确匹配返回 `PATCH_CONTEXT_AMBIGUOUS`。两者均不修改文件，并提示 Agent 重新读取后生成新 patch。
- 不做相似度、忽略空白、大小写折叠或其他 fuzzy replacement。
- 完成最新内容读取后若又有并发写入，原子替换仍可覆盖该写入；接受最后完成者获胜。
- 实际 FileChange patch 由本次最新读取内容与成功应用后的内容生成，而不是使用审批预览。

### 4.3 `delete_file`

- 执行时重新解析目标并复核当前根目录、真实路径和普通文件类型。
- 目标仍是允许范围内的普通文件时直接删除，不比较旧 hash、inode、mtime 或 file identity。
- 目标已经不存在，或复核与 `unlink` 之间变为不存在时，返回成功 `{ deleted: false }`。
- 实际删除普通文件时返回成功 `{ deleted: true }`。
- `deleted: false` 没有文件副作用，因此不创建空 FileChange；只有本调用实际删除文件时记录 delete patch。
- 目录、symlink/junction、越界路径和受保护根仍然失败，不能用幂等语义掩盖非法目标。

## 5. 审批与并发契约调整

`ApprovedToolCall.argsHash` 和批准状态继续防止模型在审批后替换调用。文件 resource plan 则从“条件写”收缩为“授权资源”：

- 保留 root kind、规范化 path、operation 和审批预览 hash。
- 删除执行所依赖的 expected file/parent identity、before hash、expected result hash 和 expected result content。
- `write_file`/`apply_patch`/`delete_file` 的执行器不再调用 FileChange OCC precondition。
- 执行前仍必须重新经过 PathGuard；目标在审批后变成 symlink、目录或越界路径时是路径安全失败，不是并发冲突。
- `write_file` 的批准内容和 `apply_patch` 的批准 patch 本身仍由 args hash 固定；允许变化的是目标文件现状及由此产生的实际 Diff。

这意味着用户允许多个可写 Session/Agent 操作同一 workspace 时，可能发生更新丢失。产品不额外加 workspace writer lease，也不伪装成自动合并；Diff 历史和 Git 状态用于事后审查。

## 6. Git-backed FileChange 与回退

### 6.1 选择的产品语义

FileChange 继续提供：

1. 应用重启后按 Session 查看 Agent 文件变更历史。
2. 关联 Session、assistant message、tool call、路径和实际 Diff。
3. 在 Git 仓库中对某一条记录尝试反向应用其 patch。

FileChange 不再提供非 Git 恢复。非 Git workspace 仍可显示 Diff 历史，但 Revert 显示为不可用并说明“需要 Git 仓库”。Session rewind 仍只修改对话历史，不自动回退文件副作用。

### 6.2 新记录形状

新 schema 删除：

- `beforeContent`
- `beforeHash` / `afterHash`
- `beforeMode`
- 基于 after state 的 OCC revert 条件

Backend 只为可回退记录额外保存完整、未截断、可反向应用的 forward patch 和 Git path；Renderer 只接收有界 Diff 投影、可选的完整 patch hash/bytes、`beforeExists/afterExists`、revert capability 和状态。建议的目标形状为：

```ts
interface FileChangeSummaryV2 {
  schemaVersion: 2
  id: FileChangeId
  sessionId: SessionId
  callId: string
  path: string
  operation: 'write' | 'patch' | 'delete'
  beforeExists: boolean
  afterExists: boolean
  diff: string
  diffHash: string
  patchHash?: string
  patchBytes?: number
  diffTruncated: boolean
  revertCapability: 'available' | 'not_git_repository' | 'legacy_unavailable'
  revision: number
  createdAt: string
  updatedAt: string
  revertedAt?: string
}

interface StoredFileChangeRecordV2 extends FileChangeSummaryV2 {
  patch: string | null
  gitPath: string | null
}
```

字段名可在实现时按现有 codec 规范微调，但不得重新引入内容快照或 hash OCC。`diffHash` 对 renderer 实际收到的有界 Diff 计算；只有具备完整 backend patch 的记录才有 `patchHash/patchBytes`。Retention 只统计完整 patch payload。

### 6.3 记录流程

1. 文件工具在执行时仅把实际读取的 before content 保留在当前调用内存中，并确定本次调用要发布的 bytes 或删除结果。
2. mutation 成功后，根据该 before 与本次调用发布/删除的结果生成 Git-compatible forward patch；create/delete 使用 `/dev/null` 语义，mode 变化只表达创建/删除所需的普通文件 mode。
3. FileChange transaction 尽力保存 patch 和摘要。容量不足、Git 探测失败或数据库失败不得反向把已成功文件操作报告为失败，也不得自动重放副作用；工具结果返回 `mutationSucceeded: true`、warning 和 `revertAvailable: false`。
4. scratch 写入继续不创建 Git/FileChange 记录。

### 6.4 回退流程

1. 根据当前 Project workspace 重新发现 Git top-level，并确认记录的 patch 只涉及允许 workspace 内的单个路径。
2. 确认记录未回退且具有完整 patch；非 Git、legacy 或丢失 payload 直接返回不可用。
3. 通过 argv-only、`shell: false`、有界 stdin/stdout/stderr 和 timeout 调用 Git，对 working tree 执行等价于 `git apply --reverse` 的操作。
4. 不传 `--cached`、`--index`、`--3way` 或 `--reject`，不修改 staging area，不产生 conflict marker 或部分 hunk 成功。
5. Git 无法精确反向应用时返回 `CONFLICT`，保留 workspace 原状，让用户重新审查；不回退到自研覆盖算法。
6. Git 成功后以 FileChange revision 标记 `revertedAt`。若状态持久化失败，明确返回“文件已改变、记录状态保存失败”，不自动再次应用 patch。

反向 patch 可以在上下文仍匹配时保留同文件中的无关修改；重叠修改、乱序回退或目标内容漂移会由 Git 拒绝。该失败是预期的 best-effort 结果，不是需要用整文件覆盖绕过的异常。

### 6.5 旧记录迁移

- SQLite 新 migration 把现有 v1 FileChange 保留为只读历史，删除 backend-private `before_content` 恢复 payload，并标记 `legacy_unavailable`。
- 不根据可能截断的旧 Diff 猜测可执行 patch，不保留旧 snapshot restore fallback。
- 新记录使用 v2 schema；Renderer 可在同一分页结果中显示 legacy 状态，或由 migration 统一投影成 v2。
- Project/Session 删除仍级联清理 FileChange，不接触 workspace 文件。

## 7. 实施阶段

### 阶段 A：公共文件系统基础设施

1. 创建 `electron/common/filesystem` 及单一出口。
2. 引入兼容 Electron Node 版本的 `write-file-atomic`，只由 `atomic-write.ts` 使用。
3. 先迁移 `config/atomic-file.ts`、`headless/patch.ts`、`session-temp/service.ts`、`skills/manager.ts` 和 FileChange filesystem 中重复的原子写。
4. 再迁移 logging、operational logging、process artifact、terminal artifact、prompt、project metadata、PathGuard 与 readonly/search 文件读取。
5. 删除兼容 facade 和重复 helper；启用“production 不直接 import Node fs”的架构门禁。

阶段 A 不改变工具业务语义，可单独提交和验证。

### 阶段 B：文件工具与审批语义

1. 新增 `write_file` schema/definition/result，删除生产 `create_file` 注册。
2. 更新 Provider tool catalog、Tool ID 常量、permission policy、auto approval 输入、prompt 文案、Subagent/Swarm catalog、Headless Runtime Identity 和测试 fixture。
3. 把文件 resource precondition 改成只描述批准资源，删除 hash/fileId/parentId/resultHash 的执行阻断。
4. `write_file`、`apply_patch`、`delete_file` 接入 common filesystem，并实现 §4 语义。
5. 保留历史 `create_file` message 的只读展示；清理或失效旧 remembered rules。

### 阶段 C：Git patch service 与 FileChange v2

1. 建立统一 Git client，收敛当前 Git tool、prompt harness 和 headless patch 中重复的 Git spawn 基础能力，但不把模型 Tool policy 混入 client。
2. 实现单文件 Git-compatible patch 生成与 working-tree reverse apply。
3. 将 FileChange 从 mutation 前 `prepareMutation` 改为 mutation 后的 best-effort annotation；文件操作不再依赖审计预写成功。
4. 增加 SQLite migration、repository/codec、shared IPC schema 和 renderer replica 迁移。
5. 删除 `application/file-change-filesystem.ts` 的 snapshot restore、`tools/file-tool-preconditions.ts` 的 OCC 数据以及不再使用的原子删除/替换实现。

### 阶段 D：UI、文档与清理

1. 审批卡明确标注“执行前预览，文件现状可能变化”；批准后不再因为旧 hash 自动失效。
2. FileChange 详情展示实际 Diff、Git revert capability、legacy/non-Git 不可用原因和 Git conflict。
3. 删除所有 `create_file` 新调用文案；release note 说明工具名与非 Git 回退能力变化。
4. 移除迁移 allowlist、废弃类型、旧测试 fixture 和双轨 fallback。

## 8. 验证矩阵

### 8.1 Filesystem common

- 覆盖已有文件保持 POSIX mode；新文件服从 umask，而不是固定为 `0600`。
- 同路径并发写按调用顺序完成，最后一次成功写入获胜；不同路径可并行。
- 写入失败或取消不会留下可见半文件，临时文件尽力清理。
- Windows 覆盖、Unicode/空格路径、只读文件、磁盘错误和跨设备错误都有确定性结果。
- JSON/text/buffer 调用者都经过同一个 atomic implementation。

### 8.2 文件工具

- `write_file` 覆盖已有文件、创建缺失文件/父目录、保持 mode，并接受审批后的外部编辑。
- `apply_patch` 在最新内容中精确唯一匹配成功；缺失/歧义均零写入；不接受 fuzzy match。
- 用测试 barrier 模拟“读取后外部写入”，固定 last-writer-wins 结果。
- `delete_file` 对已有文件返回 `deleted: true`，对不存在和删除竞态返回 `deleted: false`。
- 审批后目标变成 symlink、junction、目录或越界路径时仍拒绝。
- args/tool/path 被替换时批准失效；只有文件现状变化不失效。

### 8.3 Git revert

- 修改、创建、删除三种 patch 均可反向应用。
- 不触碰 index/staged state，不创建 commit/stash/ref。
- 同文件无关后续修改能保留；重叠修改、重复回退和乱序回退返回 conflict。
- 非 Git、Git 不可执行、空仓库、nested workspace、Unicode/空格路径和 Windows 路径均有明确结果。
- v1 记录只读可见且不可回退，v2 记录跨重启可回退。
- Git 成功但 SQLite 标记失败时不会第二次反向应用。

### 8.4 门禁

- 变更文件先格式化，日常实现阶段运行 `npm run check`。
- SQLite/IPC/tool policy 变更必须补确定性 regression coverage。
- 整个重构合并前运行 `npm run verify`，覆盖 packaged Windows、SQLite 和 Playwright Diff/Revert 流程。

## 9. 完成定义

只有同时满足以下条件才算完成：

- production `electron/**` 文件访问统一由 `electron/common/filesystem` 提供，架构测试无永久 allowlist。
- Provider catalog 只暴露 `write_file/apply_patch/delete_file`，不再暴露 `create_file`。
- 审批后的文件内容变化不会触发旧 precondition 拒绝；路径/参数授权仍不可绕过。
- 三个文件工具符合 §4 的 best-effort/last-writer-wins 语义。
- FileChange 不再持久化 `beforeContent`，代码中不存在自研整文件恢复 fallback。
- Revert 只通过 Git reverse patch 修改 working tree，非 Git 状态在 UI 中诚实不可用。
- 架构、需求、前端规范、Decision Log、Road Map、测试和 release note 不再描述旧语义。
