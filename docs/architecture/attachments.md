# 图片与本地文件输入

附件使用不可变本地快照；图片进入 Provider 原生视觉内容，普通文件通过现有本地工具读取。当前契约见 [attachments.ts](../../shared/attachments.ts)，实现入口见 [AttachmentService](../../electron/attachments/service.ts)。返回[架构总览](../architecture.md)。

## 范围与所有权

Renderer 保留 textarea、独立 composer-drafts 和 localStorage。文本与附件 ID/展示元数据按 Project、Session 或新会话占位符保存；二进制不进入 Pinia、localStorage、Message JSON 或 Trace。前端导入任务只保存来源草稿、进度和 transfer ID。每个 File/Blob 通过 256 KiB 分块 IPC 传输，主进程按 offset 顺序写文件；未完成导入阻止发送。

文件存放于 profile 的 `attachments/<project-bucket>/<asset-id>/`。Project bucket 是 projectId 的 SHA-256 前 32 位，避免原始 ID 的冒号等字符成为 Windows 文件名。Asset ID 为随机 32 位十六进制。目录保留 `original`，图片另有 `request.jpg` 和 `thumbnail.jpg`。导入结束后移动源文件不影响历史。

新增 migration `0016_attachments`，不回填旧消息：

| 表                    | 职责                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `attachments`         | 项目归属、名称、MIME、原始大小/hash、图片尺寸、请求版本大小/hash、ready/deleting 状态与创建时间 |
| `message_attachments` | 消息与附件的有序关联，和完整 Message 在同一事务插入                                             |
| `attachment_drafts`   | 草稿对附件的引用，只用于资源保留，不存草稿文本                                                  |

用户输入的 canonical parts 支持 `text`、`image`、`file`；附件 part 只包含已校验元数据。`run:start` 允许只有附件的消息，并将有序 attachmentIds 纳入幂等 hash。无文字且无附件在 IPC 和 runtime 中拒绝。用户输入事务成功后才开始主 Provider 请求。

## 导入与资源边界

导入入口包括选择文件、拖放、截图粘贴和原生文件剪贴板。已有 `@文件` 与目录 context 仍走原来的 workspace selection 流程。普通输入附件不自动解析 PDF、Office、音频或视频，也不调用供应商 Files API。

Windows DOM 剪贴板不能提供 File 时，主进程仅在粘贴动作触发后调用 Windows PowerShell 5.1 的固定 `Get-Clipboard -Format FileDropList` 脚本；文件路径不拼接进脚本，窗口隐藏，超时 5 秒，子进程使用凭据剔除后的环境。原生文件和浏览器 Blob 最终共用导入校验。原生粘贴批次持有可取消的 transfer ID，取消会终止剪贴板读取或当前文件导入，并停止后续文件。

| 限制                    | 默认值                         |
| ----------------------- | ------------------------------ |
| 每条消息附件数 / 图片数 | 16 / 8                         |
| 原始图片 / 普通文件     | 20 MiB / 50 MiB                |
| 每条消息原始附件总量    | 100 MiB                        |
| 单个 IPC 块             | 256 KiB                        |
| 请求图片长边 / 单张大小 | 2048 px / 2 MiB                |
| 一次请求的图片总量      | 16 MiB，按准备后的图片字节累计 |
| 图片解码像素上限        | 4000 万                        |

PNG、JPEG、静态 WebP 按文件签名识别；伪装的支持格式和损坏图片拒绝导入，其他格式作为普通文件。sharp 在串行后台队列中校正方向、缩放、生成 JPEG 请求图和缩略图；透明区域合成到白底，原件保留。全局 IPC 和普通 JSON 限制不变。

`zch-attachment://asset/<id>/thumbnail` 与 `/preview` 只提供生成的 JPEG，不接受路径、query、原文件或未知 variant。目录和文件路径拒绝 symlink/junction 越界。此协议同时注册于开发和打包模式，CSP 只额外允许它作为图片源。

## Provider 与上下文

Provider compile 保持纯函数。适配器生成协议内容与小型 placeholder，sidecar 明确记录附件、目标位置与编码；实际 stream 阶段通过绑定当前 Project/Session 的 resolver 读取、校验并填入字节。

| 协议               | 原生图片位置                                               |
| ------------------ | ---------------------------------------------------------- |
| Chat Completions   | `content[].image_url.url` 的 data URL                      |
| Responses          | `content[]` 中 `type: input_image` 的 `image_url` data URL |
| Anthropic Messages | `content[].image.source` 的 Base64 和 MIME                 |

普通文件在当前 Run 首次使用时恢复到已有 scratch 内按 Run 隔离的附件工作副本，向模型提供带名称与大小的原生路径。后续工具步骤复用该 Run 的工作副本；新 Run 从原件创建自己的副本，不覆盖其他 Run 的文件。权限、审批和现有 scratch 路径边界继续由工具管线负责，不向工具开放 profile 目录。

模型的图片输入设置为自动、支持或不支持。自动使用 catalog 中已有的显式 imageInput 能力，未知模型允许尝试原生协议，不按模型名称猜测。设置与 model profile 一起冻结到 Run；明确不支持图片的主模型在输入持久化前拒绝带图历史或新附图，不自动切换模型。

含附件历史使用 synthetic compaction；图片内容交给冻结的压缩 route，继续沿用当前主模型，配置中的辅助模型仍负责审批。明确不支持图片的压缩模型或任何压缩失败均保留原历史。发送前若旧历史图片加本轮图片超过 16 MiB，先压缩旧历史，然后追加本轮输入。纯文本保留原来的 native/synthetic 策略。压缩后的模型上下文依赖摘要，UI 原始图片仍可重新附加；本期没有 `view_image` 或图片 Tool Result。

模型路由变化时，transcript 保留原有文字、名称与附件引用，并携带仍处于 active history 的附件 parts。已压缩的旧图不会因换模型而重新展开。Markdown 导出和搜索保留名称与 ID；导出不嵌入二进制。

上下文 bytes 统计累加小型协议投影和准备后图片的实际字节，不扫描 Base64，不将图片字节折算成 tokens。Token 用量仍取供应商 usage。Provider request、before-LLM hook 和 Trace 保留引用投影与 canonical 元数据，不保存请求图 Base64。带图请求不保留 HTTP 错误正文和无效 SSE 原文，避免供应商回显图片字节进入失败诊断；仍保留 HTTP 状态、错误码与请求 ID。

## 保留、重试与清理

重试和 fork 复用原附件引用；历史消息编辑只重建文字并保留附件快照。归档保留附件，删除一个叶子分支不影响其他分支。附件外键在事务提交时校验，以允许 Project 删除完整级联，同时阻止删除仍被消息引用的附件。

恢复 localStorage 后按完整 Project 草稿集合对账，不能用分页 Session 列表推断草稿消失。新 Session 的草稿移交先保存目的草稿，再释放占位符引用；写入失败保留原引用。无消息和草稿引用的快照在创建 24 小时后可回收，先在 SQLite 标记 deleting，再删除受控目录，最后移除行。目录扫描收敛在移动文件与数据库提交之间崩溃、或 Project 删除后未完成的宿主清理。

取消与关闭会等待导入中的写入/图片处理完成并清理 staging；App 启动清理上次的 `_imports`，5 分钟没有数据写入的未完成上传会被回收。活动 Run 的插话仍只接受文字，带附件的草稿等待 Run 结束。

## 验证入口

- [附件存储测试](../../electron/attachments/service.test.ts)：分块、损坏图片、原件删除、重启、fork 引用、Project 级联与路径边界。
- [协议测试](../../electron/providers/attachment-input.test.ts)：三种 wire 的可解码图片、synthetic compaction、字节隔离、预算和 abort。
- [后端集成](../../electron/application/multimodal-input.test.ts)：仅附件发送、幂等、预检、历史转换、压缩和实际大图预算。
- [草稿导入](../../src/stores/attachment-inputs.test.ts)与[发送归属](../../src/stores/agent-runtime-drafts.test.ts)：异步归属、失败、取消、重启和仅附件发送。
- [构建后 UI](../../e2e/features.attachments.spec.ts)：图片/文件选择、DOM 粘贴/拖放、预览、进程重启和不支持图片的模型。
- [打包图片 smoke](../../scripts/attachment-smoke.cjs)：直接从安装产物加载 sharp 并执行图片转换，包含在 `npm run verify`。
