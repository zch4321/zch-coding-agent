# 项目短根与共享产物重构计划

- 状态：S0～S6 基础实现及 macOS/Windows 验证完成；S7 对话搜索未实施。
- 日期：2026-09-08。
- 基线：`68fefc7`；沿用现有 Electron Main、SQLite、Tool pipeline 和 Headless runtime。
- 第一阶段交付：Desktop/Headless 共用 profile 持久数据库、原生项目短根、项目共享产物、持久自增编号、旧路径兼容、按产物保留 24 小时。
- 后续交付：可搜索的对话 Markdown 副本；不作为第一阶段上线的依赖。

返回[路线图](../road-map.md)。当前实现仍以[集成规范](../architecture/integrations.md)、[工具与权限](../architecture/tools-and-permissions.md)及其 Code map 为准；本文保留设计与验收矩阵；现行行为已同步到架构规范。

## 1. 已确认的目标

用户实际遇到的问题是模型把文件工具的短路径 alias 当作 Shell 路径，导致命令执行失败。验收应验证同一路径能完成整段操作，不能只比较路径字符串长度。

1. 每个 Project 拥有稳定的项目短根，直接暴露 `<项目短根>/workspace` 和 `<项目短根>/tmp`，短根之后不再添加一层项目编号。
2. 同项目的公开 Session 与 hidden child 共用该目录，产物不按 Session 分目录隔离；不同 Project、应用 profile 仍分别管理。
3. 两个入口都必须是操作系统能访问的真实路径。文件工具、command `cwd`、Terminal 和外部程序使用相同地址；Shell 只需要自身正常的引号规则。
4. 产物目录或文件使用项目内、按类型分配的持久自增 ID。完整 Run、call、Session、execution ID 留在元数据中。
5. Desktop/Headless 使用同一产物生命周期服务，对已经结束且完成捕获收尾的产物保留 24 小时，按产物分别计时。其他 Session 的活动不会刷新其期限。
6. 对话历史后续以可搜索副本放入项目临时目录；SQLite canonical history 继续拥有历史真相。
7. 同一 profile 的 Desktop 与 Headless 共用同一份持久 `agent.db`，包括 Project、Session、消息、产物注册表和自增 ID；不新增 Headless 专用产物数据库。
8. 第一阶段支持同一 profile 下 Desktop 与 Headless 轮流运行，通过跨进程排他锁保持单一 Backend owner；不同 profile 可分别运行。

## 2. 基线行为与重构要求

| 位置                                                                                                                             | 当前行为                                                                      | 重构要求                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| [session-temp/service.ts](../../electron/session-temp/service.ts)                                                                | OS temp、24 字符 profile hash、64 字符 Session hash；command key 最长 91 字符 | 改为项目短根与持久产物编号                             |
| [path-alias.ts](../../electron/session-temp/path-alias.ts)                                                                       | 只转换四个已知 artifact 字段，生成 `ZCH_SESSION_*_DIR:/...`                   | 新输出使用原生路径；旧 alias 仅作为兼容输入            |
| [swarm/coordinator.ts](../../electron/swarm/coordinator.ts)                                                                      | manifest 将 child 的 UUID 目录绝对路径写入文件                                | 通过产物注册表生成数字目录的原生短路径                 |
| [readonly-tools.ts](../../electron/tools/readonly-tools.ts)、[result formatters](../../electron/tools/tool-result-formatters.ts) | list/glob/grep 的普通路径没有完整覆盖；read_file 返回原始文件文本             | 对工具拥有的路径元数据统一投影，文件正文保持原样       |
| [process/run.ts](../../electron/process/run.ts)、[process-tools.ts](../../electron/tools/process-tools.ts)                       | cwd 不识别工具 alias；错误、timeout、cancel 的路径进入字符串                  | 原生短根对 cwd 可用；成功与失败结果使用相同路径服务    |
| [terminal/pool.ts](../../electron/terminal/pool.ts)                                                                              | 用重启后从 1 开始的 Terminal ID 命名日志                                      | 另分配持久 artifact ID，避免重启或共享目录后覆盖旧文件 |
| [background/service.ts](../../electron/background/service.ts)                                                                    | 重启回查按 execution UUID 拼接目录                                            | 按注册表查产物，不能仅修改正在运行的内存路径           |
| [create-backend-runtime.ts](../../electron/application/create-backend-runtime.ts)                                                | 删除 Session 时删除其整个临时根                                               | 项目目录生命周期与 Session 生命周期分离                |
| [headless/runner.ts](../../electron/headless/runner.ts)                                                                          | 每次运行创建并最终删除临时业务数据库                                          | 两种宿主共用同一 profile 持久 agent.db 与项目元数据    |

现有 [ProjectMetadataStore](../../electron/project/project-metadata-store.ts) 属于暂停的 ProjectModel 功能，普通 Session 不读取或创建 `.zch/project-model.json`。新增计数器使用现有 SQLite 项目关联元数据，不依赖恢复 ProjectModel、Serena 或 code intelligence。

## 3. 目标目录与原生路径

```text
<项目短根>/
├── workspace -> 已注册项目的 canonical workspace
└── tmp/
    ├── artifacts/
    │   ├── commands/17/{stdout.log,stderr.log,result.json}
    │   ├── terminals/3.log
    │   ├── subagents/8/{result.md,activity.jsonl}
    │   ├── swarms/2/manifest.json
    │   ├── fetch/5/result.json
    │   ├── web-search/4.json
    │   └── mcp/9.json
    ├── scratch/
    └── conversations/                 # 后续阶段
        ├── index.json
        └── 6/history.md
```

图中的数字是各类型各自的编号。一次 command 只领取一个 ID，其 stdout、stderr、result 共用目录；Swarm root 和每个 child 各有所属类型的 ID。

### 3.1 项目短根分配

- 两种宿主通过共同的 profile 路径服务选择可写的原生短基址，结合用户/profile 归属和持久项目 root key 得到项目短根。Project 目录重关联仍保留 root key。
- root key 在数据库中保存，目录缺失时按原地址重建；不从当前 Session、Run 或工作区绝对路径重新生成。
- 项目短根本身已经区分 Project，模型只需要知道其 workspace/tmp 两个入口。
- metadata、计数器和身份映射保存在持久存储中，不随 `tmp` 的内容一起清理。项目目录及应用创建的文件保留现有 owner-only 权限约束。
- 实现前的原生能力用例确认 macOS/Linux symlink 和 Windows junction 的创建、Unicode/空格路径、跨卷目标及删除行为。对于不支持的目标明确报告能力失败，不返回不存在的短入口，也不退回到自定义 URI alias。

### 3.2 Workspace 链接与 PathGuard

- 应用在短根中维护 `workspace` 目录链接；进程默认 cwd 仍为 canonical workspace，Git 和项目身份继续以 canonical path 为准。
- 路径服务同时保存可展示的原生路径与 canonical path。PathGuard 只登记当前 Project 的 workspace 入口、真实 workspace 和 tmp，不放开整个共享基址。
- 只认可应用登记且目标匹配的入口链接；已有同名普通目录、未知链接或被替换的目标不能自动覆盖或信任。
- 项目重关联沿用现有 Project quiesce 流程，收敛使用旧入口的 Run/Terminal 后再更新链接，防止正在执行的命令切到其他工作树。
- 遍历、符号链接/junction 逃逸、执行前后身份检查继续生效。别名路径与真实路径必须得到相同的 root kind、审批和写入限制。
- 通用文件工具可读取同项目产物；内置写工具只能写 workspace 或 `tmp/scratch`，禁止修改 `tmp/artifacts` 和后续的 `tmp/conversations`。
- Shell 仍是现有宿主权限进程。共享文件可读不扩大 `background_cancel`、`terminal_send` 等操作 handle 的 Session 所有权。

## 4. 项目元数据与产物身份

以下是建议的数据职责，表名在实现时按现有 Repository/Codec 风格确定。

| 数据                         | 持久信息                                                                                                 | 关键约束                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Project runtime metadata     | projectId、root key、layout version、workspace 绑定                                                      | root key 在同 profile 唯一；目录可重建                      |
| Project sequences            | projectId、kind、nextId                                                                                  | 唯一键为 `(projectId, kind)`；整数在 JS safe integer 范围内 |
| Artifact registry            | projectId、kind、artifactId、source key、来源 Session/Run/call/execution、相对路径、捕获状态、时间与错误 | `(projectId, kind, artifactId)` 唯一；同一来源幂等领取      |
| Legacy path mapping          | 原 Session、旧绝对路径或根内相对路径、新 ArtifactRef、迁移状态                                           | 区分不同 Session 的同名 `terminal-1.log`                    |
| Conversation index，后续阶段 | projectId、conversationId、SessionId、同步位置和分支 revision                                            | 同一 Session 稳定编号；fork 领取新编号                      |

### 4.1 分配与恢复规则

1. Application service 在一个 SQLite 写事务中检查来源幂等键、领取编号并登记产物。
2. 事务提交后才创建文件或启动捕获。事务中不等待文件 I/O、进程或 Provider。
3. 完成捕获后更新文件状态；任务状态仍由原后台服务和 durable execution 决定，不能信任可被 Shell 修改的 manifest。
4. 文件创建失败也保留已领取编号，允许空洞；重启和清理均不复用编号。
5. 同一个 Run/call 的应用重入复用已经登记的产物，避免双重分配；重启后已退出的 Terminal 日志仍能定位，新 Terminal 必须领取新 artifact ID。
6. 正在捕获的对象持有使用租约；崩溃恢复先判定所属 backend/进程租约是否仍有效，再把遗留捕获标记为 interrupted 并完成收尾。

内部 UUID、模型的进程内后台 target 和持久 artifact ID 分别承担已有业务身份、可执行操作和文件定位。第一阶段不把它们合并，也不恢复历史上已移除的后台 public-id 迁移设计。

## 5. 工具、Prompt 与 manifest

- 引入统一项目路径服务，替换 `SessionTempPaths` 的运行时依赖；拟新增模块放入 `electron/project-artifacts/`，共享 DTO 放入 `shared/`。
- artifact registry 只存项目根内的相对路径，磁盘操作与模型输出通过同一个服务得到实际原生路径。
- 覆盖 read/list/glob/grep、write/apply/delete、command/Terminal cwd，以及 Terminal、Subagent、Swarm、Fetch、Web Search、MCP 的全部产物入口。
- 结果投影覆盖成功、非零退出、timeout、cancel、捕获失败和重启后回查；由应用拥有的错误信息携带结构化 ArtifactRef，再统一格式化。
- manifest 在写入时就使用新原生短路径；同时处理初始化与状态更新两条写入路径，增加 schema version。
- read_file 忠实返回文件内容。普通 stdout/stderr、任意 JSON、MCP 正文、历史消息中的字符串不做全局路径替换；原始工具输出与系统外部程序自行打印的 canonical 路径不受展示约定强制重写。
- 模型新输出停止主动生成 `ZCH_SESSION_*_DIR:/...`。中英文 Harness 明确两个当前项目的实际根、共享范围、scratch 写权限和产物 24 小时保留规则。
- 进程环境可增加 `ZCH_WORKSPACE_DIR`、`ZCH_PROJECT_TEMP_DIR` 等辅助变量，但主要返回值为原生路径，process 模式 args 不依赖变量展开。
- 旧 `ZCH_SESSION_*` 环境变量与工具 alias 进入独立兼容层，按原公开 owner Session 定位 legacy 视图，不能只把变量值直接改为项目共享目录；新 Harness 主动提供项目原生入口。动态物理路径继续排除在 runtime semantic hash 外，路径契约版本则纳入稳定 Harness 版本。
- 只有确实发生变化的环境上下文才按既有机制追加；不改写已经保存的 system/runtime/tool/history 消息。

## 6. 旧数据与旧路径迁移

旧文件包含完整命令输出，部分内容无法由数据库再生成。迁移必须可恢复，不能把不存在或迁移失败的文件标记为可用。

1. 按数据库中确实属于该 Project 的 Session 清单发现已知旧根；不扫描或接管其他应用的临时目录。
2. 为存量产物幂等登记新编号与旧路径映射。不能恢复完整 Run/call 信息时保留明确的 legacy 来源，不猜测身份。
3. 文件迁移使用可恢复的登记/复制或 rename/校验/完成状态；故障后可重试，成功前保留源文件。只处理已收敛的产物。
4. 对模型历史中出现的旧原生绝对路径，在旧位置保留明确登记的兼容链接；不能建立链接时保留原文件，不能假装 Shell 会执行应用的字符串映射。
5. 对旧工具 alias，依据原 Session、fork 来源和登记信息解析。多个来源存在同名候选时返回歧义及可定位的新路径，不把旧引用直接改指向项目共享根。
6. 重建应用拥有的 manifest 路径字段；原始日志与 SQLite canonical 消息保持原文。兼容路径在对应产物过期后返回明确的 expired/unavailable 状态。
7. 检查导入过已知 legacy migration 分叉的数据库；新增 migration 追加到迁移链，不修改既有 migration 文件或 checksum。

旧 scratch 也纳入保全范围。来自不同 Session 的同名脚本不能覆盖合并；按来源登记数字导入目录并保留旧路径映射，新写入使用项目共享 scratch。

模型升级后收到的新上下文说明原生路径协议。旧 alias 保持工具兼容，不承诺使历史中的错误 Shell alias 命令突然变得可执行。

## 7. 共享生命周期与 24 小时清理

### 7.1 自动清理

- 完成、失败、取消或 interrupted 的捕获，只有在追加队列收敛、句柄关闭并持久化 `finalizedAt` 后，才进入 24 小时保留窗口。
- 可回收时间为 `finalizedAt + 24h`；读取文件、其他会话活动、项目根 mtime 变化都不刷新这个期限。
- 启动恢复与周期性清理调用同一个 GC 服务。删除前再次检查租约与捕获状态，长期无输出但仍运行的 Terminal/command 不会被删除。
- 按登记的产物精确清理整个产物组；不按 Project 根或 Session 根递归回收，删除目录链接时不得跟随到真实 workspace。
- 文件删除失败保留可重试状态和有界诊断；删除成功后的中断恢复可通过文件是否存在幂等收敛。编号高水位始终保留。
- 历史迁移产物优先使用可信的完成时间；缺失时登记迁移时刻作为保守的收尾时间，避免根据某个根目录 mtime 推断所有产物的年龄。

### 7.2 会话、项目与 scratch

- Run 结束、Session 归档或删除，都不删除整个项目短根。Session 删除后移除其对话搜索副本；已经完成的共享产物按剩余 TTL 回收。
- 项目移除先收敛其活跃任务，再移除精确归属的项目运行目录和入口链接，绝不删除链接指向的 workspace。文件清理失败要保留重试线索。
- 自动清理范围只包括注册且已完成的产物。任意 model-writable scratch 文件无法凭空判断“任务已结束”，第一阶段不按猜测的归属自动删除，随项目移除或显式清理处理。
- 未来对话文件是可重建缓存，使用单独的同步/回收语义，不因为产物 TTL 删除 SQLite 对话记录；详细行为在后续阶段落实。

## 8. Headless 与 Desktop 共用持久数据库

2026-09-08 修订：两种宿主选择同一 profile 时使用同一份 `<profileData>/agent.db`。此前提出的“保留 Headless 临时业务库，再增加产物元数据库”方案取消。SQLite 支持多连接；当前临时库是宿主生命周期设计，不是数据库能力限制。

### 8.1 统一的存储与项目身份

- 提取共同的 profile/data-directory 解析与数据库路径服务。Desktop 默认与 Headless 默认指向同一应用 profile，显式 profile 选择使用同一套规则。
- Headless 移除每次 `mkdtemp` 创建业务库及退出后删除数据库的路径。任务结束时收敛自身 Backend、释放资源与 profile 所有权，Project、Session、消息和计数器继续保留。
- 按 canonical workspace 查询并复用持久 Project；缺失时由统一 Application service 幂等创建，覆盖两种宿主顺序切换后的重复注册，以及单 Backend 内多个会话并发注册的竞态。
- 项目短根、ArtifactRef、产物注册表、自增编号和 24 小时 GC 全部走同一个业务服务，产物 ID 不受使用哪种宿主影响。
- Headless 的 `artifactsDirectory` 如继续提供，定位为本次任务的结果/日志导出目标，不决定数据库、项目身份或运行时产物根；导出范围限于本次任务明确选取的记录和产物，不能自动复制其他会话数据。
- [prepareHeadlessConfig](../../electron/headless/config.ts) 当前会写入生成的 `config.json`。共用 profile 后，CLI 的 Provider/权限等参数作为本次 Run 的覆盖，不覆盖 Desktop 持久配置或其他 Session 正在使用的配置；凭据继续留在宿主受控渠道中。
- 测试、CI 如需隔离，显式选择独立 profile 或由测试夹具注入数据库目录。所有宿主使用相同持久化规则，不因 Headless 自动创建另一类存储。
- 按实际变动更新 CLI/profile、result/config/runtime-identity 契约与迁移；stdout 保持纯 JSONL，既有 Headless 工具能力范围另按宿主约束处理。

### 8.2 数据库文件共享前的后端协调

当前代码假定每个数据库由一个活跃 Backend 管理，直接把两个独立 runtime 指向同一个文件会产生应用层竞态：

- [启动流程](../../electron/application/create-backend-runtime.ts)调用 `interruptActive()`；[Repository](../../electron/persistence/subagent-repository.ts)会把所有 queued/preparing/running execution 标记为 interrupted，未区分仍存活的其他后端。
- [ApplicationStateCoordinator](../../electron/application/application-state-coordinator.ts)的事件游标与发布队列、[LiveSessionContextRegistry](../../electron/application/live-session-context-registry.ts)的运行与生命周期判断均在本进程，SQLite WAL 不会同步这些状态。
- 整个 backend 的 dispose 会收敛它管理的 Session/子任务，需要通过排他所有权确保只处理本次活跃宿主的资源。CLI 事件订阅也必须按本次 Session/Run 过滤。

用户已确定第一阶段先支持轮流运行。S0 采用共同的 profile 级跨进程排他锁：

- Desktop 和 Headless 先对同一 `agent.db` 打开最小协调连接，在 `BEGIN IMMEDIATE` 中领取 profile 所有权；业务 migration、配置初始化、启动恢复及共享目录清理必须在领取成功之后，并持有至该 Backend 全部资源收敛且数据库关闭。
- profile 已被占用时，后启动的一方明确返回 `PROFILE_IN_USE`，说明需要结束当前占用方或选择其他 profile；不强制关闭另一进程，也不静默改用临时库。
- 所有权由共同的 profile 服务维护，覆盖 CLI 进程；现有 Electron 单实例锁不能代替它。崩溃残留处理需要校验进程存活与锁所有权，不能只凭超时或可复用 PID 抢占。
- 拿到所有权后才执行遗留任务恢复，因此不会把另一活跃宿主的任务误标为中断。退出时按现有单 Backend 流程收敛自己管理的任务，保留持久数据库和项目元数据。
- 不同 profile 使用不同锁、数据库和项目短根，可以分别运行；第一阶段不新增共享后端 RPC/daemon 或跨后端事件复制。

S0 验证 profile 选择、排他锁、migration、启动失败释放、崩溃恢复、配置覆盖和顺序切换后记录的可见性。后续产物服务以这层统一生命周期为前提。

## 9. 后续：可搜索的对话 Markdown

本节为第二阶段计划，第一阶段保留扩展入口，不生成对话搜索文件或分配对话编号。

现有 [renderConversationTranscript](../../electron/session/conversation-transcript.ts) 包含用户/Assistant、工具调用参数与工具结果正文，工具结果是当时模型可见的有界投影，不会展开 artifact 中的完整日志。现有导出行为由 [transcript 测试](../../electron/session/conversation-transcript.test.ts)覆盖。

后续增加单独的 search projection 模式，保持用户导出和 provider-transfer 模式的语义独立：

- 从已提交、当前分支的完整持久消息生成；包含被 compact 移出 `inHistory` 的原始消息，排除 superseded、system/runtime/AGENTS 等内部上下文以及 provider 私有载荷。
- 默认生成同项目公开 Session 的索引和正文，主 Agent 与 child 可检索；hidden child 的完整会话导出保持现有公开边界，结果仍通过 subagent artifacts 读取。
- index 保存会话编号、标题、更新时间、同步状态和覆盖范围；正文携带可定位到源消息的 seq。当前会话编号在 Harness 中明确给出。
- 在消息事务提交后增量生成，采用原子替换和去重任务；fork、rewind、edit 等分支变化按 Session revision 重建。投影失败不回滚业务消息，也不再次调用 Provider。
- 缺失文件可从 SQLite 重建；首次批量生成和过期缓存重建必须有界，索引明确区分尚未生成与没有匹配内容。
- 普通工具结果保留当时投影，完整日志沿 artifact 路径读取；对于读取本搜索副本产生的工具结果，使用带来源位置的引用，避免把历史副本递归复制进自身。该例外只用于新 search projection。
- 继续使用现有 grep/read_file 的分页与输出预算，不把全部历史主动塞回上下文。历史资料不能被解释为本轮新的用户指令。

## 10. 分阶段实施与依赖

S0～S6 是同一个基础重构的交付范围。S0 先确定持久 profile 数据库及后端接入，S1 在同一存储上增加产物元数据，其余阶段沿用这一入口。中间提交只用于开发和验证；原生路径与兼容、清理尚未闭合时不单独发布。S7 在基础验收后再实施。

| 阶段                  | 实施内容                                                                                  | 主要入口                                                                                                                                                                                                                                                                          | 阶段验收                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| S0 统一持久库接入     | 共同 profile 路径、跨进程排他锁、Headless 持久库、复用 Project、Run 配置覆盖与退出收尾    | [database service](../../electron/persistence/database-service.ts)、[backend composition](../../electron/application/create-backend-runtime.ts)、[Headless config](../../electron/headless/config.ts)、[runner](../../electron/headless/runner.ts)                                | 占用提示、失败/崩溃释放、Desktop/Headless 轮流运行且记录接续，数据库不随退出删除 |
| S1 元数据与编号       | 定义 ArtifactRef/ProjectRuntimePaths、SQLite migration、序列、来源幂等与注册表            | [shared](../../shared/)、[persistence](../../electron/persistence/)、[Application coordinator](../../electron/application/application-state-coordinator.ts)                                                                                                                       | 并发、重启、不复用、失败空洞、同来源幂等和 legacy DB 迁移                        |
| S2 原生根与路径边界   | 项目短根分配、workspace 链接、PathGuard 根映射、文件系统包装、项目重关联                  | [filesystem](../../electron/common/filesystem/index.ts)、[path-guard](../../electron/safety/path-guard.ts)、[project-service](../../electron/application/project-service.ts)                                                                                                      | 真正的 native process 能读两个入口，跨项目/链接替换/目录逃逸被正确处理           |
| S3 全部产物写入与回查 | Command、Terminal、Subagent、Swarm、Fetch/Search/MCP 统一使用注册表；写入 manifest 新路径 | [process](../../electron/process/run.ts)、[terminal](../../electron/terminal/pool.ts)、[subagent](../../electron/subagent/execution-service.ts)、[swarm](../../electron/swarm/coordinator.ts)、[background](../../electron/background/service.ts)、[tools](../../electron/tools/) | 同项目两个会话互读、各产物数字命名、无日志覆盖、重启可回查                       |
| S4 迁移与生命周期     | 旧文件登记迁移、旧绝对路径/alias 兼容、产物级 TTL、租约及项目/会话删除                    | [session-temp](../../electron/session-temp/)、[backend composition](../../electron/application/create-backend-runtime.ts)、[session-service](../../electron/application/session-service.ts)                                                                                       | 迁移中断可恢复，active 永不回收，24h 边界与精确删除成立                          |
| S5 模型协议闭环       | 全部工具路径输入输出、错误结果、cwd、manifest、双语 Harness 切换                          | [session-tool-runner](../../electron/session/session-tool-runner.ts)、[formatters](../../electron/tools/tool-result-formatters.ts)、[prompt-harness](../../electron/session/prompt-harness.ts)、[Prompt resources](../../resources/prompts/harness/)                              | 返回路径直接用于文件工具、process 参数和 Shell；正文/历史不被重写                |
| S6 宿主与发布收敛     | 同 profile 顺序切换回归、CLI 导出/契约迁移、跨平台验证、规范和 Code map 更新              | [headless](../../electron/headless/)、[e2e](../../e2e/)、[验证指南](../guides/testing.md)                                                                                                                                                                                         | 一份 agent.db 下计数与历史连续，native Windows junction/Shell 验证，完整门禁通过 |
| S7 对话检索，后续     | 稳定会话编号、search projection、索引、提交后同步与分支重建                               | [conversation-transcript](../../electron/session/conversation-transcript.ts)、[message repository](../../electron/persistence/message-repository.ts)、[session-service](../../electron/application/session-service.ts)                                                            | 可检索 compact 前正文和工具结果，删除/回退语义正确，无递归历史膨胀               |

## 11. 验证矩阵与完成标准

| 领域         | 必须覆盖的场景                                                                                                                                                              | 现有测试入口                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心用户流程 | Session A 运行 command，Session B 复制返回路径依次 read_file、list/glob/grep、process argv 和 Shell 读取；切换 cwd 后绝对路径仍有效；Swarm manifest → child result 同样成立 | [process-tools](../../electron/tools/process-tools.test.ts)、[readonly-tools](../../electron/tools/readonly-tools.test.ts)、[swarm](../../electron/swarm/coordinator.test.ts)                                                                      |
| 持久身份     | 同项目多 Session 并发分配、Desktop/Headless 轮流领取、重启后 Terminal handle 重用、文件写失败、清理后继续编号                                                               | [pool-id](../../electron/terminal/pool-id.test.ts)、[durable concurrency](../../electron/application/durable-concurrency-recovery.test.ts)、拟新增 artifact repository 测试                                                                        |
| 文件边界     | 短入口和真实入口策略一致，跨项目、链接替换、symlink/junction 逃逸、scratch 与 artifacts 写权限、workspace 链接删除                                                          | [path-guard](../../electron/safety/path-guard.test.ts)、[file-tools](../../electron/tools/file-tools.test.ts)、[permission-pipeline](../../electron/permission/permission-pipeline.test.ts)                                                        |
| 输出与失败   | timeout/cancel/spawn failure/capture failure 的路径可用；原始日志及任意用户文本无全局替换；输出仍有界                                                                       | [run](../../electron/process/run.test.ts)、[formatters](../../electron/tools/tool-result-formatters.test.ts)、[background](../../electron/background/service.test.ts)                                                                              |
| TTL 与删除   | 未到 24h、刚好 24h、长期安静但 active、句柄未关、崩溃恢复、清理失败重试、其他会话持续活动、删除单 Session、移除 Project                                                     | [runtime cleanup](../../electron/application/create-backend-runtime-cleanup.test.ts)、[session temp](../../electron/session-temp/service.test.ts)                                                                                                  |
| 升级         | 同名 legacy terminal 日志、原生旧路径经 Shell 读取、旧 alias/fork 来源歧义、迁移中断、旧文件已过期、已知 SQLite 历史分叉                                                    | [path-alias](../../electron/session-temp/path-alias.test.ts)、[repositories](../../electron/persistence/repositories.test.ts)、拟新增 artifact migration 测试                                                                                      |
| 共享数据库   | 两宿主解析相同 profile、占用方拒绝后启动方且无副作用、启动失败释放锁、崩溃后恢复、切换后复用 Project/Session/计数、配置覆盖不写回全局、不同 profile 隔离                    | [database-service](../../electron/persistence/database-service.test.ts)、[runtime cleanup](../../electron/application/create-backend-runtime-cleanup.test.ts)、[headless](../../electron/headless/headless.test.ts)、拟新增 profile ownership 测试 |
| 宿主         | 空格/Unicode、macOS/Linux symlink、native Windows junction 和支持的 Shell；Headless 顺序重复运行、CLI 导出目录与运行时目录分离、JSONL 仅含当前任务事件                      | [command-shell](../../electron/process/command-shell.test.ts)、[headless](../../electron/headless/headless.test.ts)、[session terminal E2E](../../e2e/durable-session-terminal.spec.ts)                                                            |
| 历史检索，S7 | compact 前消息、工具结果投影、分支回退、fork、新消息提交失败、缓存重建、hidden child 边界、反复读取自身历史                                                                 | [transcript](../../electron/session/conversation-transcript.test.ts)、[durable backend](../../electron/application/durable-backend-runtime.test.ts)                                                                                                |

实施时先格式化任务文件，再运行 `npm run check`。合并或发布前运行 `npm run verify`，不重复运行已被所选门禁包含的检查。macOS 上的 Windows 交叉打包不能替代 native Windows 上的真实 junction/Shell 验证；该结果单独记录。真实 Provider、付费运行和独立 benchmark 不属于本重构的默认验证。

完成 S0～S6 后，应能在统一 profile 数据库、多会话、重启和产物过期场景中完成上述核心流程，模型新获取的应用产物地址不再依赖自定义 alias，也不携带 UUID 文件名。S7 的验收另行记录，不能将预留目录当作已经支持历史检索。

## 12. 文档与实施组织

- 按 S0～S6 划分有依赖的提交；每阶段补充对应回归，不委派实现给 coder subagent。
- 分支使用 `refactor/` 等常规前缀，保持每个代码文件在约 1,000 行以内；当前较长的服务文件在迁出 artifact 职责时自然拆分。
- 实现改变行为时，同步[产品要求](../requirements.md)、[集成规范](../architecture/integrations.md)、[工具规范](../architecture/tools-and-permissions.md)、[Agent execution](../architecture/agent-execution.md)和相关 [Code map](../code-map/README.md)；具体约束只保留一处。
- 更新存储/运行时决策、Headless 指南和 unreleased 说明，明确旧路径兼容期、共享范围及 24 小时起算点。
- 基础与后续阶段分别验收；本记录继续跟踪 S7，完成后再移入 archive 并更新入链。

## 13. 基础实现记录

- 代码分支：`refactor/project-artifacts`。唯一持久库为 profile 的 `agent.db`；协调表在业务 migration 前创建，没有 Headless 专用库。PID 存活时保守拒绝，确认退出后方可回收。
- `ProjectArtifactService` 作为现有 SessionTemp 接口的兼容门面，生产通过共享 backend 注入；模型输出为 native path，registry 以 `ArtifactRef` 保存身份和相对地址，现有工具结果 DTO 继续保留原生 path 字段。
- 旧输出采取内容校验后的保留源副本方案，过期时同时清理；scratch 使用数字导入目录和原生兼容链接，pending 登记覆盖复制、发布和链接替换的重试。
- 新增 profile 占用/崩溃恢复、项目共享路径/进程参数、独立 TTL、编号连续、旧路径/fork 歧义、迁移重入和项目移除恢复测试；Headless 验证同库记录连续、配置不写回及导出仅含本任务。
- macOS：常规检查、运行时 smoke、最终代码的 Desktop/Headless 构建和 Windows 交叉打包通过；最终 Electron E2E 为 38 passed / 1 平台 skip。最后的路径/manifest 专项回归为 27 passed，类型检查与相关文件 lint 通过。
- Windows 原生：[CI 34209026911](https://github.com/zch4321/zch-coding-agent/actions/runs/34209026911) 对实现提交 `3b1df457645b689092de5def57e6c71454ea4502` 的 Fast checks、Runtime smoke、Electron E2E、Windows package smoke 四组检查全部成功。E2E 为 39 passed；打包程序返回 `SQLITE_OK runtime=electron-packaged`（Electron 42.4.0 / SQLite 3.53.0），没有以 macOS 的 cross-target skip 代替原生验证。
- S7 保持后续范围；没有生成对话搜索目录、投影或索引。
