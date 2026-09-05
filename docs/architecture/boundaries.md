# 进程、依赖与宿主边界

本文规定依赖方向和公共入口的职责。文件定位见 [Code map](../code-map/README.md)。

返回[架构总览](../architecture.md) · [文档入口](../README.md)。

## 进程与代码边界

### `shared/`

`shared/` 不导入 Electron、Node.js、Vue、Pinia、SQLite driver 或 provider implementation。

`shared/async/` 只承载各进程行为一致、仅依赖标准 JavaScript/Web API 的异步原语。`delay` 统一 timer 与 `AbortSignal` 的监听、清理和拒绝语义；Provider retry、Tool timeout、进程终止等业务策略仍由所属领域决定，不进入共享层。

配置契约固定分为 application、assistant、integrations、models、network、providers、runtime、security 八个领域。领域叶模块可以依赖已有共享原语，models 可以组合 providers，但不得反向导入 `shared/config.ts`、根 `public-config.ts` 或 IPC transport。`public-config.ts` 是唯一 AppConfig 版本与根结构组合点；`ConfigSection` 与 `ConfigSetRequest` 归 configuration IPC 领域所有，`shared/config.ts` 只为旧调用方兼容转出。新配置代码应直接依赖所属领域。领域拆分本身不得改变 schemaVersion 或持久化形状。

Renderer 设置页用一份显式 registry 把上述八个配置领域分别映射为一个一级菜单、页面组件和其拥有的 `ConfigSection[]`；导航与动态页面分发不得再维护两份手写列表。assistant 展示语言与偏好，models 展示主/辅助模型角色和模型池，providers 展示连接、凭据、目录与模型标注，runtime 组合 Subagents、Limits 与命令/终端 Shell，security 展示权限与敏感数据，integrations 组合 Skills、MCP 与 Web Search，network 展示 HTTP proxy，application 展示日志与诊断。内部 Prompt resource、隐私确认记录和 workspace 最近路径仍归所属领域，但不因存在 schema 就自动生成 UI。项目管理与已归档对话属于 durable data 操作，在侧栏单独归入“管理”，不声明 ConfigSection。一个领域页面可以组合多个独立保存区；跨领域只读派生允许，写入必须委托实际配置所有者，不能为了页面布局把不同领域重新绑定成隐式表单事务。

Renderer 配置状态按相同所有权拆为 application、assistant、integrations、network、providers、runtime 与 security store，models 的角色与模型池继续由两个既有独立 store 负责。`agent-runtime.applyConfig` 是配置快照进入 Renderer 后的唯一 fan-out 点，各 store 只写入自己拥有的配置；Provider store 对 Limits 更新仅重算未显式覆盖的模型 Token 派生值，不接管 Limits 草稿，也不得覆盖未保存的 Provider 编辑。兼容 UI facade 只路由旧组件仍需的公开字段与动作，不重新拥有状态。领域 store 的错误分别进入统一通知桥，避免一个领域的保存状态或错误覆盖另一个领域。

IPC 契约固定分为 application、configuration、projects、sessions、runs、agents、terminals、integrations、diagnostics 九个领域。一个领域可以为原注册顺序中的不同位置导出多个子注册表；`registry.ts` 按既有顺序把它们组合为唯一 `IPC_CONTRACTS`，并派生 `IpcChannel/IpcPayload/IpcResult`。`common.ts` 和 `events.ts` 是跨领域传输原语与 push envelope，不算额外领域。领域叶模块不得导入根 registry、events composer 或 `shared/ipc-contract.ts`；shared 内部生产代码直接依赖领域、registry 或 events，兼容出口只服务尚未迁移的跨层调用方。IPC 拆分不得改变 channel 集合、channel 顺序、IPC version 或任何 payload/result/event wire schema。

Renderer bridge 使用独立、显式的 capability manifest，而不是把整个 IPC registry 自动公开。`AGENT_API_INVOKE_ROUTES` 是公开方法名到固定 request/response channel 的唯一映射，`AgentApi` RPC 类型、`AGENT_API_KEYS` 和 preload 普通 invoke 方法都从它派生；manifest 中的 channel 必须属于 `IpcChannel`。订阅方法名同样由 `AGENT_API_SUBSCRIPTION_ROUTES` 派生，但 preload 保留 Agent/Terminal 事件转发、Backend notification 缓冲和 Domain State overflow/replay 的显式 adapter。最终 plain object 经 `Object.freeze` 后通过 `contextBridge` 暴露；Renderer 永远拿不到通用 `invoke/on`。Main business handler、sender 校验、payload/result validation 继续独立且显式，不能由公开方法名反射调用。

### `electron/`

`electron/application/` 包含 production 使用的 coordinator、Project/Session services、Git Review query service、run application service 和 live-session registry；Desktop 与 Headless 通过唯一 `createBackendRuntime` 组装它们。

`electron/common/filesystem` 是 Main process 文件基础设施，不是业务 `util` 集合。通用 read/inspect/mkdir/atomic text-buffer-JSON replace/idempotent remove/temp cleanup 按职责拆成小模块，并只从 `index.ts` 公开。覆盖写由该 facade 封装 `write-file-atomic`：已有文件继承 permission mode，新文件服从进程 umask；owner/ACL/xattr 不作为跨平台产品承诺。同进程同路径写入串行，不同路径仍可并行，第三方 API 不泄漏给调用方。

除 `electron/common/filesystem/**` 和测试 fixture 外，`electron/**` production module 不直接导入 `node:fs` 或 `node:fs/promises`，由 architecture boundary test 固定。`PathGuard`、permission、Tool schema、Git 和 SQLite 不进入 common；依赖方向是业务/安全层调用 common，而 common 不反向导入业务 package。Git Review 仍是 application 层只读查询，不能把 Git process policy 塞入 filesystem。

文件 mutation 的批准与执行分离：approval 固定 tool/call 和完整 args hash，批准前校验当时的 path/scope，执行时再次经过 PathGuard 并读取最新状态；不比较审批时的 existence/hash/inode/mtime/parent identity 或 expected result，也不生成审批 Diff。`write_file` 对不存在目标创建、对普通文件整体覆盖；`apply_patch` 只在最新内容中精确上下文唯一匹配时应用，缺失或歧义零写入且不做 fuzzy replacement；`delete_file` 对普通文件删除、对不存在目标幂等返回 `deleted: false`。读取后发生的并发修改采用 last-writer-wins，原子替换只防止半文件可见，不提供 conditional mutation。应用不记录调用前后内容，也不为这些 mutation 维护 Diff 或恢复历史。

Persistence 是独立代码层，但不是独立进程、IPC service 或通用 ORM：

- `DatabaseService` 拥有 SQLite connection、migration、PRAGMA、关闭流程和 `withTransaction()`。
- Repository 只执行领域相关 SQL，输入输出是 shared canonical record 或明确的 backend-private execution record；它们接受 transaction handle，但不自行 begin、commit 或发布事件。
- Codec 只负责 SQLite row 与 `ProjectRecord/SessionRecord/MessageRecord` 或 execution record 的字段名、JSON 和时间格式转换，并在边界执行对应 schema 校验。
- Application service 拥有业务事务边界，负责在同一个 transaction 中分配 seq、插入 messages、递增 Session revision，并在 commit 后发布 records。

Persistence 不导入 provider adapter，不判断哪些消息进入模型请求，也不把 `MessageRecord` 转成 provider DTO。禁止为了抽象而引入 `BaseRepository`、动态 query DSL，或另一套语义不同的 `DatabaseSession/DatabaseMessage` 领域模型。

IPC handler 只负责边界校验、调用 application service 和编码结果，不能直接修改 repository、SQLite connection 或 runtime map。

### `src/`

Renderer 只保存：

- Project/Session/Message/backend settings 的副本。
- 当前 Project 的临时 Git Review 查询结果；它不是 durable replica。
- Run stream 的瞬时展示状态。
- command pending/error。
- draft、附件选择和其他纯 UI 状态。

它不能访问 SQLite、workspace、secrets 或 provider，也不能持久化 Project/Session 或 Git Review 结果。

### Host-neutral runtime

唯一 Agent loop 只注入 durable conversation/execution ports，不注入文件变更 journal。Desktop 使用 `userData/agent.db`；Headless 使用任务独立的临时 SQLite database，并继续共用 Prompt、Provider、Tool、Permission、compact 和 Agent loop。产品路径不存在 legacy memory/JSON fallback。
