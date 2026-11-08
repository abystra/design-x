# Part 14 · 开源 AI 创作平台调研

- 日期：2026-11-08
- 状态：调研记录（事实与判断分开标注）
- 用途：为 [Part 13](13-creative-ai-platform.md) 的平台架构提供外部依据

## 0. 方法与局限

- **怎么选的**：用 GitHub 搜索（关键词和 topic：`ai-canvas`、`text-to-video`、`ai-image-generation`、`comfyui-workflow` 等）加网页检索，按"与即梦式创作平台的架构相关度"筛选，不按热度排序。
- **怎么读的**：对 9 个仓库做了浅克隆（`--depth 1`），读 README、架构文档、ADR，以及调度、队列、供应商、Agent、计费相关的源码。infinite-canvas 在前一轮已经读过。JarvisHub 只读了论文摘要。
- **局限**：没有运行任何项目，没有做性能或质量测试。star 数和许可证来自 2026-11-08 的 GitHub API，之后可能变化。文中的源码路径都对应当天的默认分支。
- **标注**：「事实」是从代码或文档里直接读到的；「判断」是本文的推论。

## 1. 调研对象

| 项目 | 类别 | Stars | 许可证 | 主要技术栈 | 读取深度 |
|---|---|---|---|---|---|
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 生成引擎（节点图） | 145.7k | GPL-3.0 | Python, aiohttp | 执行、缓存、任务、API 节点客户端 |
| [InvokeAI](https://github.com/invoke-ai/InvokeAI) | 创作工作台（画布 + 节点） | 29.0k | Apache-2.0 | Python FastAPI, React, Konva | 服务层、队列、外部生成、画布模块 |
| [SwarmUI](https://github.com/mcmonkeyprojects/SwarmUI) | 多后端调度 | 4.8k | MIT | C# | 后端调度器 |
| [comfyui-deploy](https://github.com/BennyKok/comfyui-deploy) | ComfyUI 生产部署 | 1.5k | AGPL-3.0 | Next.js, Drizzle, Modal | README、数据库 schema |
| [Jaaz](https://github.com/11cafe/jaaz) | 画布 + Agent 设计助手 | 6.7k | 社区 / 商业双许可 | Python, LangGraph, React | Agent、工具、供应商 |
| [Toonflow](https://github.com/HBAI-Ltd/Toonflow-app) | 短剧创作平台（画布 + Agent） | 21.1k | MIT | Node/Express, Vue, vue-flow | 目录、多租户网关、计费、Agent |
| [ArcReel](https://github.com/ArcReel/ArcReel) | Agent 驱动视频工作台 | 6.3k | AGPL-3.0 | Python FastAPI, React, Claude Agent SDK | 架构文档、约 100 份 ADR 中的 6 份 |
| [OpenMontage](https://github.com/OpenMontageInc/OpenMontage) | Agent 驱动视频生产 | 78.5k | AGPL-3.0 | Python, Remotion | 架构说明、pipeline 清单、工具注册表 |
| [infinite-canvas](https://github.com/basketikun/infinite-canvas) | 纯前端画布工作台 | — | MIT | React, localforage | 前一轮已读（见 Part 13 参考） |
| [JarvisHub](https://huggingface.co/papers/2607.23588)（论文，2026-07） | 画布原生 Agent Harness | — | — | — | 摘要 |

只看了元数据、没读源码的：AUTOMATIC1111 WebUI、Fooocus、MoneyPrinterTurbo、Pixelle-Video、remotion、OpenCut、Penpot、replicate/cog、xDiT、diffusers。它们要么是单机工具，要么是单点能力（视频合成、模型封装、推理加速），对平台架构的参考价值不如上表。

## 2. 逐项分析

### 2.1 ComfyUI：节点图执行引擎

**事实**

- 工作流是一张节点图，以 API 格式提交到 `POST /prompt`，进入队列执行。`/queue`、`/history`、`/interrupt`、WebSocket 推进度。
- `comfy_execution/caching.py` 按**输入签名**缓存节点结果（`CacheKeySetInputSignature`），图里只有被修改的分支会重新执行。`cache_provider.py` 允许注册外部缓存。
- `comfy_api_nodes/` 有 52 个**云端 API 节点**（Kling、Seedream/字节、Gemini、OpenAI、MiniMax、Vidu、Runway 等）。共用的客户端 `util/client.py` 提供 `sync_op / poll_op / router_op`，会从响应头读取服务端预估耗时（p50/p90），用来显示进度百分比，同时记录已消耗的积分。
- 现在也有资产数据库（`alembic_db/`，资产与引用分表）和 `app/agent_host.py`（以 v1 契约外挂 Agent 宿主，ComfyUI 本身只做路由挂载和状态发布）。

**判断**

- 值得借鉴：**按输入签名缓存步骤结果**（适合 Recipe 的确定性步骤）；**用服务端 p50/p90 估计进度**；**Agent 宿主作为外挂契约**，主进程不承担 Agent 生命周期。
- 不适合直接拿来当平台：它是单用户执行引擎，没有租户、计费、审核这些概念。
- 合适的位置：作为**自托管生成后端**，放在某个 `GenerationAdapter` 后面。GPL-3.0 在"作为独立服务进程运行、不修改不分发"时一般不传染 SaaS 代码 [假设：法务确认]。

### 2.2 InvokeAI：最接近"专业创作工作台"的开源实现

**事实**

- 服务层拆得很细（`invokeai/app/services/` 下 50 多个服务）：`session_queue`、`session_processor`、`model_manager / model_install / model_load / model_records`、`boards / board_images`、`images / image_records`、`intermediates`（中间产物清理）、`progress_previews`、`style_preset_*`、`workflow_records`、`projects`、`users / auth`、`external_generation`。
- **队列项**（`session_queue_common.py`）带 `batch_id`、`priority`、`origin`、`destination`、`field_values`、`workflow`、`user_id`、`project_id`、`error_type`，并且有幂等冲突错误（`EnqueueIdempotencyConflictError`）。一个 batch 按 `field_values` 展开成多个 session，就是"同一提示词 × 多个参数组合"的批量生成。
- `origin / destination` 表示请求从哪里来（画布、工作流编辑器）、结果要放到哪里（画布图层、图库）。
- **外部生成**：`external_generation/providers/` 已接入 OpenAI、Gemini、Seedream、阿里云、Atlas Cloud。`ExternalProvider` 接口只有 `is_configured()` 和 `generate()`，是同步调用。
- **画布**：前端 `features/controlLayers/konva/` 把画布拆成实体适配器（栅格图层、控制图层、局部重绘蒙版、区域引导），由 Compositor 合成后转成生成图。
- **元数据回填**：生成参数写进图片元数据，`recall_parameters` 路由可以从任意一张图恢复全部参数。

**判断**

- 值得借鉴：**batch × field_values 的批量模型**；**origin / destination 显式路由结果**；**中间产物和正式产物分开管理**；**从产物恢复参数**（等价于 Part 13 的 `generations` 重放）；画布的**图层实体模型**（蒙版、控制图、参考区域都是一等实体）。
- 注意：外部供应商接口是同步的，没有提交-轮询和对账，不够视频这类长任务用。

### 2.3 SwarmUI：多后端与模型亲和调度

**事实**：`src/Backends/BackendHandler.cs` 管理多个生成后端（本地 ComfyUI、远程实例、`SwarmSwarmBackend` 联邦实例、`AutoScalingBackend` 自动扩缩）。`GetNextT2IBackend(model, ...)` 选后端时会考虑 `ModelRequestPressure`：优先把请求发给**已经加载了目标模型**的后端；某个模型请求积压时，再触发其他后端加载它。每个后端有 `MaxUsages` 并发上限。

**判断**：这是自托管 GPU 池最关键的调度策略。模型冷加载要几十秒，按模型亲和调度能直接决定首图耗时和 GPU 利用率。Design X 进入自托管阶段时应该照这个思路做 `gpu-pool` 调度器。

### 2.4 comfyui-deploy：工作流即 API

**事实**：数据模型是 workflow → workflow_version → deployment（区分 production 和 staging 环境）→ machine（类型含 classic、serverless、runpod、modal；GPU 有 T4、A10G、A100）→ workflow_run（有 origin 和状态枚举）。Modal builder 根据工作流依赖的自定义节点和模型构建机器镜像。

**判断**：自托管工作流要按"**版本化部署 + 依赖快照 + 环境隔离**"来管，不能让线上直接跑某个可变的工作流 JSON。AGPL-3.0 只借鉴设计。

### 2.5 Jaaz：画布 + 多 Agent 设计助手

**事实**

- 用 LangGraph 的 swarm 编排：`planner` 和 `image_video_creator` 两个 Agent 通过 handoff 互相转交（`langgraph_service/agent_manager.py`）。
- `server/tools/` 有 28 个工具，**每个模型一个工具**（例如 `generate_image_by_flux_kontext_pro_jaaz.py`、`generate_image_by_doubao_seedream_3_volces.py`）。底层有 `image_providers/`（ComfyUI、Replicate、火山、WaveSpeed、OpenAI、自家云）。
- 有工具确认管理器（`tool_confirmation_manager.py`），走 WebSocket，数据库是 SQLite 加迁移；前端同时依赖了 Excalidraw、tldraw、xyflow。
- 许可证是社区 / 商业双许可，商业使用有限制。

**判断**

- 值得借鉴：Agent 调用有成本的工具前**先让用户确认**。
- 反模式：**一个模型一个工具**。模型一多，工具就爆炸，Agent 的上下文和选择难度一起上升，换模型也要改工具清单。正确做法是按**能力**定义工具（`generations.create(capability, model?)`），模型作为参数，由注册表约束。

### 2.6 Toonflow：多租户化的创作平台

**事实**

- monorepo 结构：`apps/server`（Express）、`apps/web`（Vue + vue-flow）、`apps/desktop`、`apps/mobile`，节点按包拆分（`packages/nodes/imageNode`、`videoNode`、`audioNode`、`director3dNode`、`frameAnalysisNode` 等），有节点脚手架和插件开发工具。
- `packages/multiTenant/` 下有 `gateway`、`billing`、`models`、`auth`、`db`（同时支持 MySQL 和 SQLite）、`adminWeb` 和 `userWeb`。
- 网关类型（`gateway/types.ts`）：`ModelRoute`、`ModelPrice / salePrice`（成本价和售价分开）、`ModelRequestContext.recoverExisting`，以及 `ModelOutcome = usage | notSubmitted | rejected/failed/cancelled(delivered) | unknown`，对应结算 `BillingSettlement | { status: "held" }`。
- Agent 子系统（`apps/server/src/agent/`）：`runtime`、`teams`、`subAgent`、`delegation`、`a2a`、`bridge`、`skills`、`question`、`memory`。

**判断**

- 值得借鉴：**结果未知时冻结结算**（`unknown → held`），不扣费也不返还，等对账后再结算。这比"失败就返还"更严谨，能同时防止重复扣费和漏扣费。**成本价和售价分开记**，模型路由和售价一起配置。
- 注意：用一个 Express 进程同时承载多租户网关和 Agent，没有独立 Worker 和持久化队列。规模上去之后要拆。

### 2.7 ArcReel：工程化程度最高的参考

**事实**：架构文档写明的目标是"可编排、可审核、可中断恢复、可替换供应商、可追踪成本、可保留版本、可继续后期编辑"。Agent Runtime 基于 Claude Agent SDK，结构是"编排 Skill + 聚焦子智能体 + 确定性工具"。下面是读过的 6 份 ADR 和架构文档的要点：

| ADR | 决策 | 对 Design X 的意义 |
|---|---|---|
| 0007 | 重启后**孤儿任务绝不自动重新触发生成**，否则会按重启次数重复计费。提交-轮询型任务凭 `provider_job_id` 恢复轮询。`provider_job_id` 必须在进入轮询前**同步落库**，落库失败就立刻把任务标为失败。提交前先持久化版本化的执行检查点；参考素材在提交前物化为不可变的暂存副本 | 直接用于 Part 13 §5.4 的恢复语义 |
| 0050 | **图片编辑是图的分叉**：只用当前图作参考，编辑指令就是提示词，**不回写原始生成提示词**；失败时不影响原图 | 对应 `derive_kind=edit` 的语义 |
| 0054 | 图片和视频模型按**能力桶**配置：一个默认模型，再按能力（i2v、r2v）可选覆盖。能力不满足时**结构化报错，绝不静默换模型** | 和 AD-11 一致，并补上了配置形态 |
| 0055 | 生成路线在项目创建时锁定，因为路线决定了模型输入契约 | 判断"什么应该锁定"的方法：看它是否改变输入契约 |
| 0062 | 产物清单是唯一口径；**写入时记录事实，读取时推导结论**；`stale` 表示"比当前内容旧"，不等于不可用；任务状态、产物时效、批量准入、单项执行结果四条状态轴不合并 | 用于派生产物的过时判定（例如 Artboard 改了之后，用它导出的参考图是否过时） |
| 0076 | **使用记录是供应商调用的投影**，任务和调用是一对多。"排队中就取消"不会产生账单行 | 和 `model_calls` 的设计一致；明确账本以调用为单位 |
| 架构 §5.3–5.4 | Agent 工具**只声明一次**：内嵌会话通过进程内 MCP 使用，外部 Agent 通过远程 MCP 使用，两边都从同一份声明生成。每个会话由一个 `SessionActor` 独占执行，所有命令排队串行处理。另有 ADR 0029，标题为"SDK 对话记录镜像到数据库"（正文未读） | 印证 AD-15、AD-17、AD-19 |

另外，核心库 `lib/` 和服务端 `server/` 的依赖方向由 import-linter 强制检查，核心库不能依赖 HTTP 框架。

**判断**：ArcReel 是这次调研里**最值得系统学习的项目**。它的 ADR 把创作平台在计费、恢复、能力、版本上的边界情况都踩了一遍，而且多数结论和 Design X 已有的方向一致。不适合照搬的地方：它以项目目录里的 `project.json` 加文件锁作为项目数据源，适合单机或小团队，多租户 SaaS 应该用数据库作为真相源。AGPL-3.0，只借鉴设计。

### 2.8 OpenMontage：Agent 即编排器

**事实**：README 写明"没有代码编排器，你的 AI 编程助手就是编排器"。流程是：Agent 读 YAML pipeline 清单（阶段、工具、评审标准、成功门槛）→ 读每个阶段的 Markdown 技能说明 → 调用 Python 工具（`tool_registry.py` 按多个维度为供应商打分，`provider_routing.py` 处理显式指定的工具、托管方和模型）→ 自我评审 → 把状态写成 JSON 检查点 → 请用户确认 → 合成前校验 → 用 Remotion 或 FFmpeg 渲染 → 渲染后自我评审。pipeline 清单里写了 `budget_default_usd`、`max_revisions_per_stage`、`max_send_backs`、`max_wall_time_minutes`。

**判断**

- 值得借鉴：**流程定义成数据**（阶段、门槛、预算、返工上限）；**每一阶段都有评审门槛**；**渲染后自检**（ffprobe、抽帧、音频分析）。
- 不适合 SaaS：编排完全交给 Agent，预算、恢复、权限都靠 Agent 自觉。单用户本地可行；多租户平台里，这些约束必须由控制面强制执行，Agent 只能在约束内做决定。

### 2.9 JarvisHub（论文）

**事实**：把可编辑画布作为 Agent 和用户**共享的项目状态**。画布是带类型的图：节点包括提示词、参考、草稿、产物、版本、反馈和布局，连线表示依赖和谱系。每一轮，Agent 观察画布，拿到能力清单和执行授权，提出动作；桥接层校验后提交，生成新的画布状态和一条轨迹记录。论文只有定性演示，没有定量评测。

**判断**：这和 Part 13 的"画布即谱系视图 + Proposal 提交"是同一个思路，可以作为 Design X 画布 Agent 协议的理论参照。另外，**轨迹记录**（每一步的观察、动作、结果）值得落库，后续可以用来做评测和改进。

## 3. 横向对比

| 维度 | ComfyUI | InvokeAI | Toonflow | ArcReel | OpenMontage | Jaaz | Design X 现状 |
|---|---|---|---|---|---|---|---|
| 任务持久化 | 内存队列加历史 | 数据库队列 | 进程内 | 数据库队列，分通道并发 | JSON 检查点 | SQLite | PostgreSQL + pg-boss |
| 提交-轮询与恢复 | `poll_op` | 无（同步） | `recoverExisting` | 落库 job_id + 检查点恢复 | 工具内实现 | 工具内实现 | 只有设计 |
| 供应商抽象 | 每个供应商一个 API 节点 | `ExternalProvider` | 路由加售价 | 按媒体类型的后端协议 + 能力描述 | 打分选择 | 每个模型一个工具 | 只有设计 |
| 能力约束 | 节点 schema | 模型类型 | 路由类型 | 能力桶，不静默换模型 | 注册表 | 无 | AD-11 |
| 谱系与版本 | 图本身 | 元数据回填 | 节点连线 | 产物清单 + 版本 + 时效 | 检查点 | 画布 | 文档版本 + Proposal |
| 计费 | 记录积分 | 无 | 钱包，未知时冻结 | 调用账本 | `cost_tracker` | 无 | 只有设计 |
| Agent 编排 | 外挂宿主 | 无 | 团队 + 子 Agent | 编排 Skill + 子 Agent | Agent 即编排器 | 群体 handoff | Codex exec |
| 工具暴露 | — | — | 内置 | 一份声明，内嵌 + 远程 MCP | 工具函数 | LangChain 工具 | 无工具桥 |
| 画布模型 | 节点图 | Konva 图层实体 | vue-flow 节点 | 分镜工作区 | 无 | Excalidraw | tldraw Board + Artboard |
| 多租户 | 无 | 用户 + 项目 | 有 | 多用户 | 无 | 无 | workspace + RLS |

## 4. 行业已经收敛的模式

下面这些做法在多个项目里独立出现，可以视为创作平台的通用解法：

1. **生成任务必须持久化，供应商任务 ID 先落库再轮询。** 重启后，只有持有供应商任务 ID 的任务才能恢复；其余的标记失败，由用户决定是否重试，**绝不自动重新提交**（ArcReel 0007；ComfyUI `poll_op`；Toonflow `recoverExisting`）。
2. **结果未知要单独处理。** 既不当作成功，也不当作失败：冻结结算，等对账（Toonflow `unknown → held`；Design X ADR-0001 已有按 runKey 对账）。
3. **能力声明是真相源，绝不静默换模型。** 能力不满足时结构化报错（ArcReel 0054；Design X AD-11）。
4. **账本按供应商调用记，不按任务记**，任务和调用是一对多（ArcReel 0076）。
5. **编辑是分叉，不是覆盖。** 编辑产生新节点，不修改原始提示词（ArcReel 0050；InvokeAI 图层模型）。
6. **工具只声明一次，内嵌 Agent 和外部 Agent 共用**（ArcReel；infinite-canvas）。
7. **编排层加聚焦子 Agent 加确定性工具。** 主 Agent 只拿摘要和结果引用，避免上下文膨胀（ArcReel、Toonflow、Jaaz、OpenMontage）。
8. **画布是共享状态和谱系视图**（JarvisHub、infinite-canvas、InvokeAI）。
9. **批量 = 参数组合展开**（InvokeAI `batch × field_values`）。
10. **进度显示靠预估和预览**：服务端 p50/p90 推算百分比（ComfyUI），中间帧预览（InvokeAI `progress_previews`）。
11. **自托管要按模型亲和调度**（SwarmUI），**工作流要版本化部署**（comfyui-deploy）。
12. **确定性步骤按输入签名缓存**（ComfyUI）。
13. **Agent 会话串行化，对话记录镜像到数据库**（ArcReel 架构文档 §5.4；ADR 0028、0029 只读了标题）。
14. **流程定义成数据，并带评审门槛、预算和返工上限**（OpenMontage pipeline 清单）。

## 5. 反模式

| 反模式 | 出处 | 问题 | 正确做法 |
|---|---|---|---|
| 一个模型一个 Agent 工具 | Jaaz | 工具爆炸，换模型要改工具 | 按能力定义工具，模型作为参数 |
| Agent 即编排器 | OpenMontage | 预算、恢复、权限靠 Agent 自觉 | 控制面强制约束，Agent 只在约束内决策 |
| 浏览器直连模型，Key 在前端 | infinite-canvas | 无法计费、审核、防滥用 | 服务端生成网关 |
| 插件在主页面执行 | infinite-canvas | 多租户下等于 XSS | iframe 或 Worker 隔离，服务端声明式适配 |
| 重启后自动重新提交生成 | ArcReel 0007 记录的历史做法 | 重复扣费 | 有任务 ID 就恢复轮询，没有就标失败 |
| 文件系统作为项目真相源 | ArcReel、OpenMontage | 多实例、多租户下靠文件锁不可靠 | 数据库为真相源，对象存储放二进制 |
| 外部供应商只有同步接口 | InvokeAI | 视频长任务、断线恢复都做不了 | 提交-轮询-回调三种模式统一 |

## 6. 许可证注意事项

| 许可证 | 项目 | 可以怎么用 [假设：以法务意见为准] |
|---|---|---|
| MIT / Apache-2.0 | InvokeAI、SwarmUI、Toonflow、infinite-canvas | 可以参考和复用代码，保留版权声明 |
| GPL-3.0 | ComfyUI | 作为独立服务进程运行；不把它的代码并入 Design X 的分发包 |
| AGPL-3.0 | ArcReel、OpenMontage、comfyui-deploy | **只借鉴设计和 ADR 思路，不复制代码** |
| 社区 / 商业双许可 | Jaaz | 只借鉴设计 |

## 7. 对 Design X 的输入

这些结论已经合并进 [Part 13](13-creative-ai-platform.md)：

| 调研结论 | Part 13 中的落点 |
|---|---|
| 任务 ID 先落库、孤儿任务策略、执行检查点、参考素材暂存 | §5.4 恢复语义 |
| 结果未知时冻结结算 | §5.4、§10 |
| 能力桶配置、不静默换模型 | §5.2 |
| 账本按调用记、一对多 | §4.3、§10 |
| 编辑即分叉、产物时效 | §4.2、§7.5 |
| 蒙版、控制图等画布编辑实体 | §7.4 |
| 成本价与售价分开、冻结结算 | §10 |
| 依赖方向用 lint 强制 | §12.1 |
| 批量展开、origin / destination | §4.2、§6.1 |
| p50/p90 进度、预览帧 | §5.6 |
| 一份工具声明、按能力定义工具 | §6.3.4 |
| 编排 Skill + 子 Agent、会话串行化、对话记录镜像、轨迹落库 | §6.3.3、§6.3.6 |
| 流程定义带门槛、预算、返工上限；步骤缓存 | §6.2 |
| 模型亲和调度、工作流版本化部署 | §5.7 |
