# 设置交互规范

当前规范；返回[前端总览](../frontend-spec.md)。菜单由 [settings-tabs.ts](../../src/components/settings/settings-tabs.ts) 的八个配置领域与两个管理页面组成，下面的 Agents、Limits、Skills 等为所属领域中的组合区域，不是独立一级菜单。

## Settings

Settings 使用工作台的设置视图：侧栏导航选择领域，内容区由 SettingsPage 分发到对应页面。它不使用 modal，也不为每个领域建立独立路由。

### Assistant

- 界面语言支持简体中文和英文，切换后立即更新 UI，并同步主进程 `assistant.language`。
- 展示可编辑的中英文 assistant preferences，支持保存和恢复默认值；base harness instructions 不在设置页中编辑。
- 保存后的偏好从已有对话的下一轮模型调用开始生效；不得把 API Key 等凭据写入偏好。

### Project

- 使用项目列表展示所有 backend `ProjectRecord`，每项显示名称、完整路径、当前项目标记和已加载的活跃对话数量。
- 列表提供 Choose workspace / Add project，并允许从任意空闲项目行发起移除。
- 移除操作必须二次确认，并明确清理应用内 Session、Message、Subagent 和运行资源但不删除 workspace 目录或文件；Trace 日志仍由 Logging 设置单独管理。
- 项目中存在 running、start pending 或 awaiting approval 的对话时禁用移除并解释原因；移除当前项目后选择下一个可用项目及其最近的活跃对话，没有剩余项目时进入空状态。
- 不展示内部 session ID。

### 模型

- 页面顶部为“默认模型”分节：主模型与辅助模型各提供模型和思考深度两个下拉。主模型的精确 route 用于新对话默认值，会话/草稿级覆盖不受影响；辅助模型用于对话自动起名和自动权限审批，默认项“跟随当前模型”即留空并禁用其思考深度下拉。候选为所有 Provider 的已启用模型，思考深度只列出该模型标注支持的档位；模型切换后若原档位不兼容，UI 保留本地组合并提示用户显式选择，不自动升降档，组合有效后才原子自动保存完整角色。

### Providers

供应商是独立配置领域，模型池位于 Models 领域；Provider id 是内部稳定标识，不在 UI 展示。

- Base URL。
- Provider 默认模型：新 Provider 不预填虚构模型名。用户填写 API Key 后，表单在 600ms 静默期后自动保存并立即刷新 `/models`；已有凭据时进入页面或切换 Provider 卡片也会用已保存 route 静默刷新。显式刷新按钮先排空自动保存再刷新，失败时保留上次成功缓存。
- 模型清单、启用池与能力：模型目录刷新只按大小写敏感的模型 ID 增量追加，不覆盖或删除旧条目；目录接口不可用时可手工新增模型。“新增模型”对话框同时填写模型 ID、最大上下文、压缩阈值、最大输出、思考档位和能力等级；确认后一次保存并启用，校验失败时保留对话框内容。每个模型配置行提供删除确认；Provider 默认模型和当前辅助模型禁用删除，其余模型删除后同时退出本地目录和启用池、清除覆盖配置，Provider 再次返回时允许刷新重新发现。可筛选穿梭框左侧显示完整清单，右侧显示 `enabledModelIds`，只有右侧模型能进入 Composer、主/辅助角色和 Swarm 的下拉候选。Provider 默认模型下拉读取完整清单；选择后自动把它加入右侧并禁用移除，更换后旧默认模型恢复可移除。穿梭框下方始终显示全部已知模型的 Provider 返回/内置/保守默认来源与配置，不只显示右侧模型；上下文长度和最大输出允许用户按模型覆盖，且解释它们分别用于本地上下文预算、自动压缩和单次生成预留。仅采用目录协议明确返回的容量字段，未知模型显示保守默认值提示。每个模型还可标注“思考档位”（多选，缺省=全部六档 `off|low|medium|high|xhigh|max`）与“能力等级”（light/standard/strong，为模型池调度提供权威标注）；已标注模型在角色与 Composer 的思考深度下拉中只呈现标注子集。Provider 草稿若会破坏已保存的辅助精确 route，则暂停自动保存并要求用户调整标注或角色；全局主角色属于宽松偏好，失效时在新对话禁用发送，不自动改写或升降档。
- Token 估算：默认保守估算，可切换为自定义 `bytesPerToken`；说明该值只影响预算估算，不能关闭字节/行数硬限制。
- API Key 配置状态、更新和清除。
- Provider 名称、类型、地址、默认模型、Token 估算和模型覆盖均自动保存；Provider 不展示或持久化默认 Reasoning。切换卡片或退出页面前排空当前保存，失败时留在当前草稿并显示错误。
- renderer 不读取或回显已保存 API Key。

### Auto approval

- Auto 模式的审批模型是辅助模型；辅助模型未配置或解析失败时回退到该 Run 的主模型。不再存在独立的审批路由配置、思考档位选择或手动保存动作。
- 审批路由使用辅助模型角色显式保存的思考档位；回退时使用该 Run 主模型 route 的思考档位，不做隐式升降档。
- Provider 保存不能修改模型角色；草稿兼容性检查读取已保存辅助模型的精确 `model + reasoning`。删除正被辅助模型引用的 Provider 时，辅助模型复制当前主模型的完整 route；未配置的辅助角色继续保持“跟随当前模型”。

### Permissions

- 默认权限模式。
- 模式选择下固定一行说明：自动模式使用辅助模型（未配置时使用当前模型）进行审批。
- Sensitive Data：off/warn/confirm。
- Path globs。
- Content patterns。
- Remembered rules 列表。
- 每条规则显示 tool、workspace scope、arg constraints、expiry 和来源 call。
- 支持删除规则，不支持编辑为更宽松的任意 JSON。
- 全页修改自动保存（文本域防抖），页首提供立即保存与状态；不再有手动保存步骤。

### Limits

- 运行限制保持单列分组和自动保存；页首提供立即保存/失败重试与状态，不让旧保存响应覆盖更新中的草稿。
- Commands 分组提供“命令与终端 Shell”的解释器选择与重新扫描。`Auto` 项显示当前实际解析的解释器；显式选择项只来自 Main process 已发现的 profile，并显示实际 executable path。
- 已保存 profile 不可用时保留原选择、显示 fallback 警告并临时使用自动解释器；Renderer 不自行探测 PATH，也不允许输入任意 executable 或启动参数。
- 该选择同时影响 `run_command.shell` 与新打开的交互 Terminal，不影响 `run_command.process`、内部 Git 或已在运行的 Terminal。模型只接收实际解析后的 `command_shell`，设置页不提供“让模型选择 Shell”的选项。

### Agents

- 提供默认关闭的 Subagent 开关，以及 1–1,440 分钟的 worker timeout；默认 30 分钟。
- 使用与运行限制一致的自动保存交互，并保留页首立即保存按钮和保存状态。
- 明确提示额外 Provider 请求/费用，展示 Session active leaf 容量 maxSubagents；不显示全局 Run 并发值或独立单次 Swarm 上限。
- 提供模型池配置。模型池使用 `Provider → model → reasoning` 穿梭树选择精确 route，只读展示 Provider 模型能力，不配置并发或 Agent 数量。
- 设置变更从下一次主 Run 生效；不提供隐藏 child Session 入口、完整 transcript、取消操作或自定义 child 工具列表。运行状态和历史回看位于 Artifact 的 Agents Tab，不与设置表单混合。
- `inherit` child 的人工审批在对应 Agent 展开详情中显示，展示工具、参数、原因和 policy signals，并提供批准/拒绝；隐藏 Session ID 不进入 Renderer。

### Skills

- 展示 name、description、source、sha256 短摘要和启用状态。
- 支持 HTTPS URL、主进程文件选择器安装和手工目录 refresh。
- 新安装和首次扫描的手工 skill 默认禁用；必须由用户显式启用。
- 格式错误、重复名称、符号链接和超限文件显示诊断，不中断设置页。

### Logging

- Trace 开关和独立风险告知。
- retention days。
- max total bytes。
- 提供受控的打开日志目录和清理已关闭 trace 入口。
- 提供 trace 列表、离线 replay 摘要和 Prompt Inspector；不提供 trace fork 或使用当前凭据重放 Provider 请求的入口。
- 展示 Provider 原始 usage 派生的 token/cache 指标与 TTFT/总时延；字段缺失时明确显示 `Provider not provided`。
- 完整 Session transcript 已支持只读查看与导出；每次导出显示隐私告知。更广泛的搜索与批量管理仍需单独设计。

### Session 生命周期

- Settings 不展示 `Start session` / `Close session` 作为主流程按钮。
- Settings 提供“已归档对话”菜单项：分页列出 archived Session，支持恢复；永久删除使用 Naive UI 确认框，并在存在 fork 子 Session 时由 backend 拒绝。
- 新建对话只产生 renderer draft；首次发送用一个 backend command 创建 durable Session/initial Messages 并启动 Active Run。
- 切换对话不关闭后台 `LiveSessionContext` 或 `ActiveRunExecution`；归档/删除 Session、移除项目和退出应用才清理对应 runtime 资源。退出时统一取消 active runs 并关闭 PTY。
- 未发送 draft 与 context attachments 不进入 backend，不保证 A → B → A、renderer reload 或应用重启后恢复。
- 应用重启后从 backend Session snapshot 恢复完整 messages、Goal/Plan、模型和模式；partial assistant output、pending approval 和 Active Run 可以丢失，不显示伪造的 interrupted message。
- 若恢复后的 canonical history 停在 backend 定义的可续跑边界，最后一个对应 turn 的回退/分支操作栏追加 Naive UI 图标按钮“继续”。点击直接调用 `run:continue`，不向 composer 写入文本、不发送空消息；Run active、等待审批或 continuation pending 时隐藏该入口。
