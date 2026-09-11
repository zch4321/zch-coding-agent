# 结构审查整改记录

日期：2026-09-11。起点：`master` / `c020992d8f62a8c567a88f0c7d144d464409e777`。工作分支：`fix/structure-audit-remediation`。

本文记录本地审查材料 `2026-09-11-duplication-redundancy-coupling.md` 的整改结果。原材料位于 Git 忽略的 code-review-report 目录，本文独立说明问题与处理，不依赖该目录的探针或链接。实现和测试均分阶段提交、推送，未合并主线。

## 处理结论

15 个主项与两个附录问题均已处理到明确边界。优先修复可触发的行为，再收敛状态所有权、公共契约和依赖。没有引入通用 Provider 基类、ORM 或新的全局状态层。本轮没有数据库表或 migration 变更；持久化字段和历史格式沿用现有契约。

| 原编号      | 处理结果                                                   | 对应提交  |
| ----------- | ---------------------------------------------------------- | --------- |
| S01、附录 B | 跨块秘密脱敏；快速崩溃不再重置重启预算                     | `2354cb7` |
| S03         | Provider 命令不再写入 Runtime limits                       | `1024308` |
| S02         | 统一保存竞争处理，修复 Web Search 两阶段保存及密码输入绑定 | `9ed74c1` |
| S07         | 共用增量参数累计和 Provider 纯函数                         | `4629787` |
| S08         | 等待只查生命周期，返回时才构造完整投影                     | `3ee277e` |
| S12         | 文件失效按项目归属，面板按可见状态刷新                     | `3e6247a` |
| S05         | Session 使用宿主中立错误，retry 保留领域原因               | `d87d706` |
| S10         | 共用进程树终止原语，保留真实收尾与失败；硬截止未引入       | `62c8e4c` |
| 附录 A      | 真正命中后才计入搜索上限；保留最近 2,000 条正文窗口        | `c68b900` |
| S06         | 执行复核独立于审批编排，加入传递依赖检查                   | `341d9e0` |
| S09         | 执行用量统一 schema、类型、解析与聚合                      | `24dc062` |
| S14         | 记录、Run 选择、上下文捕获拆为窄端口                       | `ee40ceb` |
| S11         | Facade 类型由实际公开能力推导                              | `8844afa` |
| S04         | 公共/内部 Session 共用提交准备与恢复字段                   | `7844efa` |
| S13         | 移除旧 mode 写入口和仅测试使用的 Provider wrapper          | `a9ab37f` |
| S15         | Git 工具与 Review 共用参数构造，明确处理超时/取消          | `ea68078` |

## 按提交顺序说明

### 1. `4a4951f`：排除本地审查脚本的 lint 干扰

开始整改时，开发门禁扫描到了 Git 已忽略的本地审查探针，产生 17 个 `no-undef` 错误。将 `docs/code-review-report/**` 加入 ESLint 忽略项，与该目录的 Git 和文档维护约定一致。没有删除探针，也没有把它们的“确认旧缺陷”断言当作修复后的验收。

### 2. `2354cb7`：统一秘密脱敏，限制 MCP 连续重启

新增 [redact-secrets.ts](../../electron/common/redact-secrets.ts)，字符串与 JSON 字符串值共用匹配规则；MCP stderr 先增量解码 UTF-8，再经过跨块 redactor。尚可能组成秘密的后缀在判定前不公开，支持短秘密、重叠匹配及多个秘密。JSON 键的既有处理语义不变。

MCP 握手成功不再立即清零重启计数：只有手动重启，或连接持续 ready 至少 60 秒后退出，才重置预算。保留最多 5 次尝试与指数退避，旧连接回调不能污染新连接；重载不能绕过待执行退避或耗尽预算。

验证：27 个针对性用例覆盖全部字节切分位置、每次公开 stderr 快照、短值/Unicode/重叠、快速崩溃、稳定后重置、旧回调以及 disable/dispose。

### 3. `1024308`：Provider 保存只写自己的领域

从 IPC schema 和 ConfigStore 移除 `provider-settings.limits`。Provider store 不再读取或提交 Runtime 页的草稿，也不使用 Provider 保存回包回填 Runtime。模型默认容量来自已提交配置的独立快照。

这解决的是跨领域写入，不能只靠保存 signature 防止旧回包覆盖。相关配置 fixture 改为显式执行各领域命令，IPC schema 快照同步更新。验证覆盖无效、未初始化和未保存的 Runtime 草稿不阻塞 Provider 保存，持久化 limits 保持独立。

### 4. `9ed74c1`：统一设置保存的竞争处理

新增 [settings-draft-save.ts](../../src/stores/settings-draft-save.ts)，在首次 await 前捕获表单，统一相同请求合并、后续保存请求、基线更新、异常收尾和按版本回填。Runtime/security 保留自动排空后续草稿的行为；手动保存的页面保留后来输入，避免旧响应覆盖。

Web Search 同时捕获凭据、provider 和 count；凭据响应只更新凭据状态，第二步配置保存使用原始快照。部分失败时保留尚未保存的配置或新凭据。密码输入修正为 Naive UI 的 `v-model:value`。语言设置失败时回退至最后成功保存的语言。

验证覆盖真实 NInput 键入、key/count 同改、两阶段部分失败、保存中继续编辑、重复点击、排队、flush 和异常后的再次保存。领域仍自行构造 payload 和处理告知，没有把所有设置改成同一种提交策略。

### 5. `4629787`：Provider 参数按增量计数

在已有 Provider 公共模块中引入参数 accumulator，维护文本、UTF-8 字节数和跨 chunk 代理项状态。Chat、Responses、Anthropic 共用它；超限时保留此前合法状态。共性 JSON、Intent、数值和 Call ID helper 也收敛到一个来源，各协议的 wire format、thinking 与 continuation 保留原适配。

工作量回归：1 MB / 1,000 chunks 的字节检查由累计扫描 500,500,000 字节变为 1,000,000 字节。该数值说明扫描工作量，不代表实测耗时提升 500 倍。另覆盖空块、畸形参数、Unicode 切分、真实上限和失败回滚。

### 6. `3ee277e`：Background 等待与展示解耦

新增按 parent Session 校验归属的批量生命周期查询，只读取 execution 的 id、kind、status。等待循环不再解析结果、查询 children/count 或探测 artifact；满足条件、超时后才读取完整返回结果，并以最终权威快照处理完成竞态。list 复用已读取的根记录。

验证：一秒持续运行的目标经历 11 次轻量采样，前 900 ms 没有完整记录、子任务或 artifact 展示读取；完整结果只在返回时构建。覆盖取消、缺失/越权目标、完成竞态和 list 复用。保留 100 ms polling，没有为局部查询成本引入新的事件订阅生命周期。

### 7. `3e6247a`：按项目和面板可见性刷新文件

独立 workspace-files store 按事件所属 Session 的 projectId 维护 revision。归属暂不可用时等待 replica 补齐，不能猜成当前选中项目。Files/Diff 接收 active 状态，隐藏时不发起刷新，重新进入时合并刷新；150 ms 窗口合并密集变化，同一项目的自动刷新串行执行。

保留项目内 Run 终态失效作为 exec 文件改动的兜底，并保留迟到响应的项目/代次保护。真实组件测试确认后台 B 不触发 A 的 IPC、隐藏期间零新查询、进入后一次刷新，以及旧项目响应不覆盖当前视图。已发出的读取不强制取消。

### 8. `d87d706`：领域错误不再依赖 IPC

[DomainError](../../electron/common/domain-error.ts) 承载可公开的 code/message/details。Session 不再导入 IpcFault，ApplicationError 与 IPC 在各自边界转换它。

retry 已先提交 rewind，随后若因凭据或告知条件失败，现在保留原始领域错误，并继续附带 `mutationSucceeded: true`。未知内部异常仍保持安全错误映射。验证覆盖 retry 的加载/启动失败、再次重试，以及 start/retry/continue IPC 编码；架构测试禁止 Session 和可移植 Runtime 导入 IPC，显式保留 Electron 事件适配器的职责。

### 9. `62c8e4c`：共用 OS 终止原语，等待实际收尾

runCommand 与 CommandSessionManager 共用 [process-tree.ts](../../electron/process/process-tree.ts)。Windows 整树强制终止成功后不再排队重复停止；taskkill spawn/非零退出失败不因根进程已退出而被忽略。POSIX 仅把整个进程组不存在视为完成，不用根进程状态吞掉访问失败。

一次性 runner 等待真实 close 和在途终止请求后再完成，并在收尾后抛出未解决的终止错误。超时/取消竞争只启动一次停止流程，异常路径保持输出资源所有权。验证包括假系统错误、根已退出、在途终止与 close 竞态，以及真实进程超时和 0–2 层后代退出检查；CommandSession 的再次停止回归保持通过。

保留边界：操作系统拒绝终止且进程一直存活时，一次性 runner 仍等待，错误也需到收尾后才能交付。未实现后台接管或硬截止返回；那需要另行设计进程所有权和日志收尾，直接提前返回会遗留活进程。

### 10. `c68b900`：搜索上限作用于真实命中

删除原始 `parts_json` 候选查询。[session-search.ts](../../electron/application/session-search.ts) 分页读取公开 active Session，标题直接匹配，正文复用 MessageRepository.searchText；只有真正命中才计入返回上限。标题和正文统一使用 `toLowerCase()`，正文匹配解码后的文本。

验证覆盖 101 个较新的工具参数/control 假命中之后仍能找到正文、JSON 字段名不命中、Unicode/反斜杠/换行、项目过滤、隐藏和归档排除。超过 2,000 条记录时，两种搜索沿用相同的近期正文窗口。

取舍：每页 100 个 Session，按页补足结果，内存读取有界；无命中时总查询量仍随会话数增长。本轮没有新增搜索投影表或 FTS，不宣称实现了大规模全文检索优化。

### 11. `341d9e0`：审批复核独立于审批编排

将参数 hash 与批准令牌复核移到 [approved-call-validation.ts](../../electron/tooling/approved-call-validation.ts)。PermissionPipeline 负责授权与签发；ToolExecutor 只依赖底层复核，不再间接加载内置工具或 AutoApprover。

增加执行器回归：缺少 brand、Session/Run 错配、参数变化、workspace/temp scope 变化都在进入 handler 前拒绝。架构测试使用 TypeScript AST 追踪静态及字面量动态 import 的传递运行时依赖，排除显式 type-only 边。

保留一条 `run_command → exec_command` 提示分支。它没有引入运行时业务依赖，暂不为单条文案扩展 registry 配置协议；以后出现更多替换提示时再统一拥有者。

### 12. `24dc062`：执行用量只有一个契约来源

[execution-usage.ts](../../shared/execution-usage.ts) 持有七字段 schema、派生类型、零值、数值投影和聚合。Main 批量、Renderer 批量、Headless 增量、Swarm 子摘要复用它；Headless 补齐安全整数范围。执行仓储的 usage 恢复为具体类型，读取时剥离额外字段。UI 的模型 DTO 也从 shared 派生；未使用的 raw payload 保持 opaque，避免 Vue 对递归 JSON 类型无限展开。

同一 fixture 经四条消费路径得到相同结果；缺失/cache/reasoning、空集合、非法数字和整数上限都有覆盖。执行总数溢出时饱和于安全整数上限，避免辅助统计破坏运行。Session 用量继续保留可选指标，“未报告”和零仍有区别，原始 Provider 数据不进入执行摘要。

### 13. `ee40ceb`：Usage 消费者只依赖所需能力

[usage/contracts.ts](../../electron/usage/contracts.ts) 定义 UsageRecorder、UsageRunLifecycle、UsageContextCapture 及输入。Provider、标题和压缩只需要 record；RunController 只需要选择当前 Run；完整组合仅用于装配。

上下文捕获接收 Session ID、Run ID、route 和工具字节统计，在入队前复制，再读取已提交历史。服务不再接收可变 SessionState 或编译后的完整请求。验证覆盖标题未采纳仍计费、压缩/Provider 观察、隐藏会话过滤，以及入队后修改输入不污染快照；49 个相关用例通过。

### 14. `8844afa`：Facade 类型和实现共用能力清单

移除宽泛 Omit 交集和手写 Proxy 路由。[store-facade.ts](../../src/stores/store-facade.ts) 从具类型的成员清单建立实时 getter/setter，再合并动作和派生视图，遇到重复能力名称直接拒绝。AgentFacade 由实际返回值推导，内部方法不会自动进入公开类型。

移除测试中的内部成员豁免清单，改为编译期拒绝内部方法、响应式双向读写、绑定动作及别名、getter 惰性和名称冲突测试；相关 facade/runtime/草稿/设置竞争共 58 个用例通过。没有迁移全部设置页面；现有消费者先保持稳定，后续页面修改再直接使用领域 store。

### 15. `7844efa`：共享 durable 字段算法，保留事务差异

[durable-session-state.ts](../../electron/session/durable-session-state.ts) 共用增量历史选择、metadata 快照/比较以及失败恢复。内部路径现在和公共路径一样恢复 goal、plan、模型、模式和 history，并复制可变字段。

保留 public 的 waiter/请求幂等、公开 commit，和 hidden 的 execution ownership/内部事务；没有用统一基类抹平它们。参数化用例覆盖两种路径的恢复、无变化跳过、压缩触发与 tool-batch 失败隔离，结合真实 backend/child 回归共 27 个用例通过。

### 16. `a9ab37f`：清理不在生产使用的写入口

删除 SessionManager.updateSessionMode。模式修改测试改走与 IPC 相同的 SessionService.update，覆盖 active Run 拒绝、revision 冲突、archive 竞争、下一 Run 的 `permission_mode: confirm`，并确认单次模式保存不额外追加 history。

需要保留的运行期 mutation guard 测试改用生产可达的 updatePlanStatus，不再靠旧 mode API 验证。ConfigStore 的 getDeepSeekApiKey/setDeepSeekModelCatalog 薄 wrapper 同步删除，测试使用通用 Provider 方法；配置迁移与历史读取保留。符号搜索无遗留调用，72 个相关用例通过。

### 17. `ea68078`：Git 共享参数构造，入口保留各自政策

[git/command.ts](../../electron/git/command.ts) 统一禁用 pager、颜色、可选锁，并为 diff/show 禁用外部 diff/textconv。命令仍使用直接进程参数数组。工具和 Review 保留各自的路径/ref 限制、审批、输出预算和结果格式。

Review 在解析输出前显式识别 timedOut/cancelled，避免 exitCode=0 的部分输出被视为成功。验证两入口确实调用同一 builder、带空格路径的参数边界、取消/超时，以及真实 Git 的路径、binary、diff、读写操作；36 个相关用例通过。

## 未扩大实施的部分

- **进程清理硬期限**：本轮统一原语和错误语义，未新增后台接管/原生进程容器。保留所有权优先于提前返回。
- **事件化 background wait**：轻量批查已移除展示 I/O；新增订阅、漏事件恢复和取消解绑目前收益不足。
- **全文索引**：先修复匹配与 LIMIT 的正确性，保留近期窗口。若大量会话下搜索延迟仍高，再用数据决定 projection/FTS 和迁移。
- **所有设置页迁离 facade**：公开契约已经准确，无需为收敛类型扩大页面改动范围。
- **统一 Provider/事务/终端模型**：各自协议、可见性及所有权不同，继续保留适配边界。replica 与 live overlay、各信任边界的校验、配置 migration、暂停的代码智能模块均未按“重复”删除。
- **按行数拆大文件**：只抽出有独立职责的部分，没有单纯为了低于 1,000 行拆迁移历史或大装配文件。

## 最终验证与交付状态

各阶段完成格式化、相关回归和类型检查；涉及 schema、审批、IPC、进程和持久化行为的改动均有针对性覆盖。最终 `npm run check` 全部通过：Documentation 1.0 秒、Format 11.6 秒、Lint 12.1 秒、Typecheck 21.6 秒、Unit tests 69.2 秒。门禁覆盖至实现提交 `ea68078`，本文收尾更新后另行通过格式与文档链接检查。

本轮未执行付费 `test:real`，也未执行用于合并/发布的完整 `verify`、打包和 Playwright。主线未合并；合并前仍应运行仓库规定的 `npm run verify`。
