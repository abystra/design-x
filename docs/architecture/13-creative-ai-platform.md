# Part 13 · 创作型 AI 平台架构设计方案

- 日期：2026-11-08（v2：合并开源调研结论）
- 状态：**已批准的 v2 实施边界见 [统一 v2 设计](15-design-x-v2.md) 与 [ADR-0002](../adr/0002-design-x-v2-runtime-storage-generation.md)**。本篇保留平台演进研究，超出 v2 的内容仍为后续提议。
- 关系：补充 [Part 5](05-backend-and-ai.md) 和 [Part 7](07-data-and-interfaces.md)；在 [ADR-0001](../adr/0001-codex-e2b.md) 基础上细化 Agent 层
- 参考：Design X 现有代码（`apps/harness`、`packages/ai-runtime`、`apps/worker`）、WorkX Codex Harness，以及 [Part 14 开源调研](14-open-source-landscape.md)（ComfyUI、InvokeAI、SwarmUI、comfyui-deploy、Jaaz、Toonflow、ArcReel、OpenMontage、infinite-canvas、JarvisHub）。正文中"〔参考：X〕"标出借鉴来源
- 标注约定同 [README](README.md#标注约定)：[已核验] / [二手] / [假设] / [待定]

## v2 实施修订（2026-11-08）

当前采用独立 TypeScript 控制面、OpenAI Image API、R2、E2B 内 Python Runner/Codex app-server 0.166.0 和 Go matfs。WorkX 固定来源为 f81c31a3b09d13d8955248ec7bdefbdfc1f08a6e；源项目测试与目标重新验收分开记录。

本期只有图片、参考编辑、三个可执行 Recipe 与可编辑设计，不含视频、外部 MCP、会员支付或位图分解。原生动态工具通过 root journal 调用受限共享应用服务。Image API 为同步调用，没有可轮询供应商 job ID；受理未知不自动重发，24 小时释放用户预占，成本保留未知。图片资产与 Artboard 分型，文字和品牌通过确定性排版保持独立图层。详细数据模型、迁移、实现及故障规则以 Part 15 为准。

## 0. 历史研究摘要（以下演进项不代表本期全部实现）

Design X 的目标是从"AI 可编辑设计"扩展成类似即梦的创作型 AI 平台：生图、改图、生视频、画布编排、资产沉淀，再加 Agent 协作。本方案的核心判断如下：

1. **地基是"生成"，不是"Agent"。** 创作平台的大部分请求是"提示词 + 参数 + 参考图 → 生成"，不需要 Agent。要先建**生成网关**和**一等生成记录（`generations`）**，Agent 只是调用它们的上层客户端之一。
2. **每一次生成都是可重放、可派生的记录。** 再次生成、做同款、变体、局部重绘、高清、扩图、图生视频，本质上都是在**生成谱系图**上派生新节点。这张图在画布上可以直接看到，借鉴 infinite-canvas 的"配置节点 → 结果节点 + 连线"。
3. **三个可替换接缝**：模型供应商（`GenerationAdapter`）、Agent 宿主（`AgentRuntime`）、执行沙箱（`SandboxProvider`）。产品数据只放在 Design X 控制面，任何一个接缝换实现都不动地基。
4. **后续可探索 MCP；v2 使用受限原生工具桥。** 同一套工具既服务平台托管的 Agent（Codex app-server），也服务用户自带的 Agent（本机 Codex 或 Claude Code 通过远程 MCP 接入）。
5. **合规、成本、地域是一等约束。** 审核、AI 标识、计量账本、部署地域在第一条生成链路里就要做，不留到上线前补。**沙箱和模型的部署地域是当前最大的返工风险，要最先验证。**
6. **恢复和计费语义要先定死。** 异步供应商才保存任务 ID 并轮询；本期 OpenAI Image API 保存调用意图和响应；孤儿请求不自动重新提交；结果未知时冻结结算；编辑是分叉而不是覆盖。这些规则在 ArcReel、Toonflow、ComfyUI 等项目里都是踩过坑之后才定下的（见 Part 14），Design X 应该在写第一行生成代码前就采用。

## 1. 背景与目标

### 1.1 产品能力范围

| 能力域 | 内容 | 阶段 |
|---|---|---|
| 生成 | 文生图、图生图、多参考图、风格/主体参考 | G1 |
| 编辑 | 局部重绘、消除、扩图、高清、抠图、图层分解 | G2 |
| 设计 | 可编辑 Artboard（文字、图层、模板）；位图转可编辑 | 已有，G2 扩展 |
| 视频 | 文生视频、图生视频、首尾帧、续写、配音配乐 | G4 |
| 画布 | 无限 Board：生成节点、谱系连线、方案组、对比 | G1 起 |
| 资产 | 素材库、生成历史、收藏、标签、相似检索、品牌套件 | G1 起 |
| Agent | 多步创作、澄清提问、批量与组合任务、自带 Agent 接入 | G3 |
| 社区 | 作品发布、做同款（需要产品证据，见 Part 1 非目标） | 后续 |

### 1.2 与现有定位的关系

Part 7 §G.1 规定"候选就是可编辑 Artboard，不是图片"。本方案保留这一点，同时把**位图生成结果**也作为一等产物：

- **位图产物**：`generation_outputs → assets(kind=generated)`，放在 Board 上作为图片节点。
- **设计产物**：`documents(kind=artboard)`，仍然是可编辑的 Creative Document。
- **两者之间的桥梁**：图层分解、抠图、OCR 把位图转成 Artboard；Renderer 把 Artboard 导出成位图，再作为下一次生成的参考图。

"位图生成 + 可编辑设计"在同一张画布上互相转换，这是 Design X 相对纯生图平台的差异点。

### 1.3 非目标

- 不自研基础生成模型。自托管只在成本触发时引入（§5.7）。
- 不做通用工作流搭建器（ComfyUI 那种节点编程）。画布节点表达的是**创作谱系**，不是可编程 DAG。
- 不让模型或 Agent 直接写业务数据（延续 AD-10）。

## 2. 设计原则

| # | 原则 | 落地方式 |
|---|---|---|
| P1 | 控制面是唯一真相源 | PostgreSQL 加对象存储。SDK thread、沙箱文件、供应商 URL 都不是产品数据 |
| P2 | 生成优先，Agent 其次 | 直接生成不经过 Agent 和沙箱；Agent 只通过工具触发同一条生成路径 |
| P3 | 生成即记录 | 每次生成都完整记下输入、参数、模型版本、seed 和父生成，支持重放与派生 |
| P4 | 接缝可替换 | Adapter、AgentRuntime、SandboxProvider 三个接口，配契约测试 |
| P5 | 异步是默认 | 所有生成都走 jobs 状态机；同步返回的供应商也按异步模型处理 |
| P6 | 显式路由，不隐式回退 | 延续 AD-11：换模型会改变创作结果，必须由配置或用户选择触发 |
| P7 | 合规内建 | 生成前后审核、隐式与显式标识、来源记录都在主链路上 |
| P8 | 成本可见 | 提交前预估，执行时预留，完成后结算；每个产物都能追溯到成本 |

## 3. 总体架构

```mermaid
flowchart TB
  subgraph L1["体验层"]
    Board["Board 画布（tldraw）<br/>生成节点 · 谱系连线 · 方案组"]
    Panel["生成面板<br/>提示词 · 参数 · 参考图"]
    Chat["对话 / Agent 侧栏"]
    Lib["资产库 · 生成历史"]
    Editor["Artboard 编辑器"]
  end

  subgraph L2["接入层"]
    API["API（Fastify）<br/>REST · SSE · 幂等"]
    MCP["远程 MCP Server<br/>OAuth · 范围令牌"]
  end

  subgraph L3["编排层"]
    Direct["直接生成"]
    Recipe["Recipe 引擎<br/>代码定义的持久化步骤"]
    AgentRT["Agent Runtime<br/>AgentRuntime 接口"]
    ToolGW["Tool Gateway<br/>授权 · 预算 · 幂等 · 审批"]
  end

  subgraph L4["能力层"]
    GenGW["生成网关<br/>注册表 · 适配器 · 审核 · 计量 · 转存"]
    Media["媒体流水线<br/>ingest · 渲染副本 · 抠图 · 分解"]
    Render["Renderer（Chromium）"]
    Eval["评估器<br/>OCR · 相似度 · 美学"]
  end

  subgraph L5["数据层"]
    PG[("PostgreSQL<br/>业务 · jobs · 谱系 · 账本 · outbox")]
    OSS[("对象存储 + CDN")]
  end

  subgraph EXT["外部与隔离环境"]
    Providers["模型供应商<br/>图像 · 视频 · LLM · 审核"]
    Sandbox["沙箱池<br/>Codex app-server + Harness"]
    BYO["用户自带 Agent<br/>Codex / Claude Code"]
  end

  Board & Panel & Chat & Lib & Editor --> API
  BYO --> MCP
  API --> Direct & Recipe & AgentRT
  MCP --> ToolGW
  AgentRT <--> Sandbox
  Sandbox -->|"MCP（能力令牌）"| ToolGW
  ToolGW --> Direct & Recipe
  Direct & Recipe --> GenGW
  Recipe --> Media & Render & Eval
  GenGW --> Providers
  GenGW & Media & Render --> OSS
  L3 & L4 --> PG
```

横切能力：身份与租户（RLS）、配额计费、审核合规、审计、可观测（OpenTelemetry），贯穿 L2 到 L5。

### 3.1 三种请求路径

| 路径 | 场景 | 是否经过 LLM | 是否经过沙箱 | 预计占比 |
|---|---|---|---|---|
| 直接生成 | 面板提交、画布节点"运行"、再次生成、派生操作 | 只在可选的提示词增强步骤 | 否 | 绝大多数 [假设] |
| Recipe | 商品套图、海报改尺寸等固定流程 | 只在结构化步骤 | 否 | 中等 |
| Agent 回合 | 模糊、多步、需要澄清或组合的请求 | 是 | 平台托管时是 | 少数，但单次成本最高 |

三条路径最后都汇入**同一个生成网关**。生成记录、审核、计量、谱系只实现一次。

## 4. 核心领域模型

### 4.1 实体关系

```mermaid
erDiagram
  GENERATION ||--o{ GENERATION_OUTPUT : produces
  GENERATION }o--o{ ASSET : "uses as input (role)"
  GENERATION_OUTPUT ||--|| ASSET : "materialized as"
  GENERATION }o--o| GENERATION : "derived from"
  GENERATION ||--|| JOB : "executed by"
  JOB ||--o{ MODEL_CALL : records
  AI_TURN ||--o{ GENERATION : "may trigger"
  RECIPE_RUN ||--o{ GENERATION : "may trigger"
  BOARD_ITEM }o--|| GENERATION : "displays"
  PROVIDER_MODEL ||--o{ GENERATION : "serves"
  USAGE_LEDGER }o--|| GENERATION : "charges"
```

### 4.2 `generations`：用户可见的创作记录

**generation 和 job 分开建模**：generation 是长期保存、可重放的创作记录；job 是一次执行，可以重试，也可以清理。

| 字段 | 说明 |
|---|---|
| `id`, `workspace_id`, `project_id`, `created_by` | 租户与归属，开启 RLS |
| `origin`, `origin_ref` | `direct \| recipe \| agent \| mcp \| api`，以及对应的 turn、recipe_run 或 MCP 会话 |
| `destination` | 结果放到哪里：`board:{item_id}`、`artboard:{id}/layer`、`library`。由服务端按它放置产物，前端不再自己判断〔参考：InvokeAI〕 |
| `batch_id`, `batch_index` | 一次批量提交展开出的多条生成共享 `batch_id`（§6.1） |
| `capability` | 例如 `image.generate`，见 §5.1 |
| `provider_model_id`, `model_version` | 指向 `provider_models`，记录实际调用的版本 |
| `prompt`, `negative_prompt` | 用户原文 |
| `prompt_final`, `prompt_enhancer` | 增强后实际发给模型的提示词，以及增强用的模型；不增强时为空 |
| `params` | 归一化参数：比例、尺寸、数量、强度、风格预设、时长等 |
| `provider_params` | 供应商特有参数的透传，按 schema 校验 |
| `seed` | 用户指定或平台生成；供应商不支持时记为空 |
| `inputs` | `[{asset_id, role, weight?}]`。role 取值：`reference \| init \| mask \| style \| subject \| first_frame \| last_frame \| audio` |
| `parent_generation_id`, `derive_kind` | `regenerate \| variation \| edit \| inpaint \| outpaint \| upscale \| cutout \| decompose \| animate \| extend \| remix` |
| `status`, `stage` | 见 §5.4 状态机 |
| `idempotency_key` | `(workspace_id, idempotency_key)` 唯一 |
| `cost_estimate`, `cost_actual`, `credits` | 平台积分与人民币成本，分开记录 |
| `moderation` | 输入和输出的审核结论摘要 |
| `error_class`, `error_public` | 错误分类，加上可以展示给用户的错误信息 |

`generation_outputs`：`generation_id, index, asset_id, status, seed_actual, moderation_verdict, scores(jsonb)`。一次请求生成 4 张图时，**单张失败或被审核拦截不影响其他几张**。

`asset_lineage`：在生成提交时写入边 `(from_asset_id, to_asset_id, generation_id, kind)`，用来快速查询"这张图从哪来、派生出了什么"。它可以从 `generations` 重建，但为了查询性能单独物化。

`generation_checkpoints`：在**第一次向供应商提交之前**，在同一事务里写入一份版本化的执行检查点。内容包括实际选中的供应商和模型、归一化后的请求，以及参考素材暂存副本的引用和摘要。恢复和对账只认这份检查点，不再从当前项目状态重新推导请求〔参考：ArcReel ADR 0007〕。

**编辑语义：编辑是分叉。** `derive_kind=edit / inpaint` 只用父产物作底图，编辑指令就是这次的提示词，**不回写**父生成的提示词。编辑失败时父产物不受影响。之后对父生成"再次生成"，会回到原提示词，编辑效果不会被带上——这是分叉语义的固有结果，需要编辑效果时从子生成继续〔参考：ArcReel ADR 0050〕。

### 4.3 与现有实体的关系

| 现有实体 | 变化 |
|---|---|
| `assets` | 新增 `kind=generated`；`provenance` 改为引用 `generation_id`，不再内嵌一份 JSON |
| `jobs` | `kind=gen.image / gen.video / gen.poll` 指向 `generation_id`；仍是执行状态机 |
| `model_calls` | 每次供应商调用一行，包括重试和轮询之外的调用；关联 job 和 generation。**generation 和调用是一对多**，账本（`usage_ledger`）是调用的投影：没有真正发给供应商的请求（比如排队中就取消），不产生账单行〔参考：ArcReel ADR 0076〕 |
| `ai_turns` / `ai_attempts` | 保留。Agent 通过工具触发的生成，其 `origin_ref` 指向 turn |
| Board 文档 | 新增 `generation` 类型的条目（引用 `generation_id`）和谱系连线，见 §7.1 |

## 5. 生成网关

生成网关是平台的心脏。它在进程内以库的形式实现（`packages/generation`），由 Worker 执行；满足 Part 5 §E.2.3 的拆分条件后再独立部署。

### 5.1 能力模型

```text
image.generate   image.edit     image.inpaint   image.outpaint
image.upscale    image.cutout   image.decompose image.describe
video.t2v        video.i2v      video.extend    video.lipsync
audio.tts        audio.music    llm.chat        llm.structured
vision.analyze   moderation.text moderation.image
```

每种能力都有平台定义的**归一化请求 schema**。供应商的差异放进 `provider_params` 和注册表里的 `limits`。

### 5.2 模型注册表

注册表是代码里的配置，经过代码评审，按环境覆盖，同时同步一份到 `provider_models` 表供审计和展示（延续 Part 5 §E.4.6）：

```yaml
- id: volc.seedream-x            # 示例，实际 model_id 以控制台为准 [待定]
  provider: volcengine-ark
  version: "2026-xx"
  capabilities: [image.generate, image.edit]
  region: cn
  mode: async                    # sync | async | callback
  limits: { max_refs: 10, ratios: ["1:1","3:4","9:16","16:9"], max_pixels: 4194304, max_count: 4 }
  supports: { seed: true, negative_prompt: false, cancel: false }
  pricing: { unit: image, cny: null, credits: null }   # 上线前从控制台录入 [待定]
  concurrency: { per_provider: 20, per_workspace: 4 }
  status: candidate              # candidate | active | deprecated | disabled
  display: { name: "…", badge: "…", tier: standard }
```

规则：

- `status=deprecated` 的模型仍然能**重放**历史生成（如果供应商还在提供），但新建时不再展示。
- 模型下线后，历史生成的"再次生成"要明确提示"原模型已下线"，让用户选择替代模型，不能静默替换。
- 自托管模型（§5.7）也作为普通条目注册，`provider=self-hosted`。
- **能力桶配置**：每个 workspace（或项目）为每种媒体配置一个默认模型，再按能力细分可选覆盖（例如 `video.i2v` 和多参考图生视频分别指定）。没有配置覆盖的能力回退到默认模型；默认模型不支持该能力时**结构化报错，并告诉用户去配置哪个桶**，绝不自动换成用户没选过的模型〔参考：ArcReel ADR 0054〕。
- **能力事实只有一份**：界面展示、费用预估、参数约束（时长、分辨率、参考图数量）、Agent 工具查询和实际执行，都从注册表的同一份能力声明求值。

### 5.3 适配器接口

```ts
interface GenerationAdapter {
  readonly provider: string;
  validate(req: NormalizedRequest, model: ModelSpec): ProviderRequest;      // 不满足 limits 就抛出 permanent 错误
  estimate(req: NormalizedRequest, model: ModelSpec): CostEstimate;
  submit(req: ProviderRequest, ctx: CallCtx): Promise<
    | { kind: "done"; outputs: ProviderOutput[] }
    | { kind: "pending"; providerJobId: string; pollAfterMs?: number }
  >;
  poll?(providerJobId: string, ctx: CallCtx): Promise<ProviderStatus>;
  verifyCallback?(headers: Headers, body: unknown): ProviderStatus | null;
  cancel?(providerJobId: string, ctx: CallCtx): Promise<void>;
  classify(error: unknown): "transient" | "permanent" | "moderation" | "quota" | "unknown";
}
```

- 参考图通过短时效的预签名 GET 或供应商文件 API 传入（Part 5 §E.6）。
- `ProviderOutput` 只能是字节流，或者网关下载后立即转存的临时 URL。**供应商 URL 永远不写进文档，也不返回给浏览器。**
- 每个适配器都有契约测试：录制回放加少量真实冒烟调用，覆盖成功、审核拒绝、超时、429、部分失败。

### 5.4 生成状态机

```mermaid
stateDiagram-v2
  [*] --> created
  created --> moderating_input
  moderating_input --> rejected: 输入违规
  moderating_input --> reserved: 配额预留成功
  moderating_input --> failed: 配额不足
  reserved --> submitted
  submitted --> running: provider_job_id
  submitted --> transferring: 同步返回
  running --> transferring: 完成
  running --> failed: 失败 / 超时
  transferring --> moderating_output
  moderating_output --> succeeded: 全部通过
  moderating_output --> partially_succeeded: 部分拦截
  moderating_output --> rejected: 全部拦截
  created --> cancelled
  reserved --> cancelled
  submitted --> cancelled
  running --> cancelled
  succeeded --> [*]
  partially_succeeded --> [*]
  failed --> [*]
  rejected --> [*]
  cancelled --> [*]
```

- 每个阶段都有完成标记，重新投递时从未完成的阶段继续（Part 5 §E.5）。
- `job.reconcile` 负责补拉"有 `provider_job_id` 但没有结果"的任务。如果供应商不支持取消，结果晚到时直接丢弃，并删除已转存的对象。
- 进入终态时结算配额：按实际产出的张数或秒数提交，失败和被拦截的部分返还。

**恢复规则**〔参考：ArcReel ADR 0007、Toonflow `ModelOutcome`〕：

1. **供应商任务 ID 先落库，再进入轮询。** `submit` 返回了 `provider_job_id` 但落库失败时，立刻把生成标为失败，并打一条带固定标记的结构化日志，供运维人工处理；不能在任务 ID 没落库的情况下开始轮询。
2. **Worker 重启或租约失效后，孤儿生成一律不自动重新提交。** 能恢复的（有检查点、有 `provider_job_id`），恢复轮询；不能恢复的，标为失败并说明原因，由用户决定是否重试。自动重新提交会让用户为同一次请求付多次钱。
3. **结果未知时冻结结算。** 无法判断供应商是否已经受理（例如提交请求超时）时，状态记为 `unknown`，预留的配额进入 `held`，既不扣也不返还；对账确认后再结算。
4. **参考素材提交前先物化。** 实际发给供应商的参考图、首尾帧、音频，在提交前复制成不可变的暂存副本并记录摘要；供应商只读这份副本，避免排队期间用户改了素材导致请求和记录不一致。
5. **413 这类请求体过大错误**，只有在能证明供应商还没受理时，才允许压缩参考图后重试。

### 5.5 提示词层

- **增强是可选步骤**：用户开启后，用一个廉价 LLM 改写提示词。改写前后都记进 `generations`，界面可以对比、回退。
- **风格预设、模板提示词、负向提示词**作为版本化资源（`prompt_presets`），生成时记录预设的 ID 和版本，避免预设改动后无法重放。
- 用户文本、OCR 文字、文件名一律放进数据区（Part 5 §E.4.5），防止提示注入。

### 5.6 背压与公平

- 每个供应商、每个模型各有一组并发令牌；每个 workspace 有生成并发上限；按套餐分优先级队列 [假设]。
- **图片、视频、音频分通道并发**，避免几分钟一个的视频任务占满图片通道〔参考：ArcReel〕。
- 对用户展示排队位置和预计耗时，提供方式是 SSE 推送 `generation.progress`。
- **进度估计**：大多数供应商不返回百分比。网关为每个模型维护近期耗时的 p50/p90，按已等待时间推算进度条；供应商若在响应里给了预估耗时，优先采用〔参考：ComfyUI `poll_op`〕。自托管后端能拿到中间帧时，推送预览缩略图〔参考：InvokeAI `progress_previews`〕。
- 设全局成本熔断（Part 5 §E.7）。

### 5.7 自托管模型

触发条件（满足任一）：某个能力的月成本超过阈值；需要供应商不提供的能力（如私有 LoRA、品牌风格模型）；数据不能出域。

做法：`ml-worker`（Python，GPU 池）作为一个 `GenerationAdapter` 接入。如果要用 ComfyUI 一类的工作流后端，**也只作为某个 Adapter 内部的实现细节**，不作为平台的编排层，避免两套编排语义。抠图、高清这类小模型优先自托管（Part 5 已列出 BiRefNet 的许可核验结论）。

自托管时的三条规则：

- **按模型亲和调度。** 调度器知道每台 GPU 机器当前加载了哪些模型，请求优先发给已加载目标模型的机器；某个模型积压时，再让空闲机器加载它。模型冷加载通常要几十秒，这条规则直接决定首图耗时和 GPU 利用率〔参考：SwarmUI `ModelRequestPressure`〕。
- **工作流版本化部署。** 线上只跑已发布的工作流版本；每个版本带依赖快照（自定义节点、模型文件及其哈希），按版本构建镜像，分 staging 和 production 两个环境。注册表里的模型条目指向某个已发布版本，而不是一份可变的 JSON〔参考：comfyui-deploy〕。
- **ComfyUI 以独立服务进程运行**，通过它的 HTTP 和 WebSocket API 调用；不把它的代码并入 Design X 的分发包（GPL-3.0，见 [Part 14 §6](14-open-source-landscape.md#6-许可证注意事项)）。

## 6. 编排层

### 6.1 直接生成

`POST /v1/generations` → 事务内写 `generations` 和 `jobs`，并 `boss.send()` → 返回 `generation_id` → 前端订阅 SSE。

派生操作是同一个接口，带上 `parent_generation_id` 和 `derive_kind`：

| 用户操作 | 请求 |
|---|---|
| 再次生成 | 复制父生成的参数，换一个新 seed |
| 做同款 | 复制参数和提示词，替换主体参考图 |
| 变体 | `derive_kind=variation`，输入为父产物 |
| 局部重绘 / 扩图 / 高清 / 抠图 | 对应的 `image.*` 能力，输入为父产物加 mask 或参数 |
| 图生视频 | `video.i2v`，`first_frame` 为父产物 |

**批量提交**：请求里可以带 `batch: { mode: "product" | "zip", fields: [{ path, values }] }`。服务端把它展开成多条 generation，共享同一个 `batch_id`，例如"同一个提示词 × 3 种比例 × 2 个模型"展开成 6 条〔参考：InvokeAI `batch × field_values`〕。批量提交时**整批预估、整批预留配额**：预留不足就整批拒绝，不出现"跑了一半没额度"的情况。

### 6.2 Recipe 引擎

延续 Part 5 §E.4.2：代码定义、版本化、每步有 schema、预算、超时和幂等键。补充三点：

- Recipe 里的生成步骤**一律调用生成网关**，产出普通的 `generations`。这样谱系、计量、审核都不需要特殊处理。
- 长时子任务（比如视频）用 `job_waiters` 挂起，不占用 Worker。
- **每个 Recipe 都声明预算和门槛**：`budget`（积分上限）、`max_wall_time`、每个阶段的 `max_revisions`，以及评审门槛（评估器分数、OCR 比对、渲染后检查）。控制面强制执行这些上限，超出就停在当前阶段并请用户决定〔参考：OpenMontage pipeline 清单〕。
- **确定性步骤按输入签名缓存。** 布局计算、模板填充、渲染预览这类纯函数步骤，用输入的哈希做缓存键；用户只改了文案时，抠图和背景生成不必重跑〔参考：ComfyUI `caching.py`〕。**生成步骤不缓存**，同样的输入再次生成就应该得到新结果。
- **渲染后自检**：视频类 Recipe 在最终交付前，用 ffprobe 检查时长和码率、抽帧检查是否黑帧、检查音频电平，不通过就不报告成功〔参考：OpenMontage〕。
- 引入工作流引擎（Temporal、Restate、DBOS 等）的触发条件：单个 Recipe 超过约 20 步或包含人工审批；或批次超过 1,000 个子任务（Part 10 已列）；或 pg-boss 加 awaiter 的状态机复杂到难以测试 [假设]。触发前不引入。

### 6.3 Agent Runtime

#### 6.3.1 接口

```ts
interface AgentRuntime {
  open(spec: RunSpec): Promise<RunHandle>;                // 绑定沙箱，启动宿主进程，注入 MCP 配置
  turn(h: RunHandle, input: TurnInput): AsyncIterable<AgentEvent>;
  interrupt(h: RunHandle, turnId: string): Promise<void>;
  answer(h: RunHandle, requestId: string, answer: unknown): Promise<void>;
  close(h: RunHandle, mode: "pause" | "destroy"): Promise<void>;
}

type AgentEvent =
  | { type: "message.delta" | "message.completed"; text: string }
  | { type: "reasoning.summary"; text: string }
  | { type: "plan.updated"; steps: PlanStep[] }
  | { type: "tool.started" | "tool.completed"; toolCallId: string; name: string }
  | { type: "ask_user"; requestId: string; question: string; options?: string[] }
  | { type: "turn.completed"; usage: Usage }
  | { type: "error"; class: ErrorClass; message: string };
```

控制面只认识 `AgentEvent`。事件按 `(run_id, attempt, seq)` 去重、落库，再通过 outbox 和 SSE 推给浏览器（ADR-0001 协议不变）。

#### 6.3.2 适配器

| 适配器 | 状态 | 说明 |
|---|---|---|
| `codex-exec` | 现状（ADR-0001） | `@openai/codex-sdk` → `codex exec --experimental-json`。单向，适合一次提交、一次取回 |
| `codex-app-server` | **建议作为主适配器** | 沙箱内运行 `codex app-server`，走 JSON-RPC：`thread/start / resume / fork`、`turn/start`（可带 `outputSchema`）、`turn/interrupt`。支持执行中提问、中断、同一 thread 连续多轮。infinite-canvas 的 `canvas-agent/src/agent/codex-client.ts` 是同技术栈的现成参考 |
| 其他宿主 | 预留 | Claude Agent SDK、OpenAI Agents SDK，或自研循环。只要实现 `AgentRuntime` 并消费同一套 MCP 工具即可 |

**从 `codex-exec` 切换到 `codex-app-server` 修订了 ADR-0001 的"当前 SDK 路线保持不变"，需要用户确认后另立 ADR。** 切换前要用真实 E2B、目标 Codex 版本和 DeepSeek 跑通下面四个验收场景：

1. 带参考图生成可编辑画板，继续修改时正确保留原版本。
2. 执行中提问，收到回答后继续；用户停止后没有迟到的提交。
3. Worker 重启或沙箱丢失后，从业务上下文恢复，或者明确结束；结果是否已提交不确定时先对账。
4. 并发执行时，授权、预算、超时依然生效；实测首个结果耗时和每轮成本。

另外，Codex 版本要在模板里固定，并和 WorkX 统一升级节奏，避免两个仓库各自漂移（目前一个是 0.144，一个是 0.166）。

#### 6.3.3 状态与恢复

- **真相源是业务上下文**：会话消息、Board 和 Artboard 当前版本、已确认的工具调用、生成记录。任何一轮都能从这些数据重建 thread。
- **原生 thread 续接只是优化**：同一个沙箱还活着时，用 `thread/resume` 节省 token 和延迟。**不把 Codex 原生会话文件当作持久化格式**，因为它是上游的内部格式，随版本变化。WorkX 保存原生文件再恢复的做法不作为 Design X 的地基。
- **沙箱按会话复用**：同一个 AI 会话内多轮复用一个沙箱，空闲时暂停，超时后销毁 [假设：以 E2B 暂停和恢复的实测成本与延迟为准]。不再每一轮新建沙箱。
- **会话命令串行化**：每个 AI 会话在控制面由一个会话执行者独占，发送、中断、回答提问、撤回排队消息都进入同一个命令队列串行处理，避免并发命令把宿主状态弄乱〔参考：ArcReel `SessionActor`〕。
- **对话记录镜像到数据库**：宿主产生的事件按 `AgentEvent` 归一化后全部落库，界面只读数据库里的事件流，不直接读宿主的原生记录。

#### 6.3.4 工具面（MCP）

工具由控制面的 **Tool Gateway** 实现，以 MCP 协议暴露。平台托管的沙箱通过出站白名单加能力令牌访问；用户自带的 Agent 通过远程 MCP 加 OAuth 访问。两边用**同一份**工具定义。

| 级别 | 工具（示例） | 规则 |
|---|---|---|
| 读 | `board.describe`、`artboard.describe`、`assets.search`、`generations.get`、`lineage.get` | 免费；返回 ID 和摘要，**不返回 URL** |
| 提议 | `artboard.propose_ops`、`artboard.create_version`、`board.place_items` | 只产生 Proposal 或新版本；位置由确定性布局算法决定 |
| 生成 | `generations.create`（含派生）、`recipes.run` | 有成本；按预算扣减；超过单次阈值时转成用户审批 |
| 等待 | `jobs.await` | 挂起回合，释放 Worker |
| 交互 | `ask_user` | 通过 `AgentEvent.ask_user` 推给前端 |

工具设计参考 infinite-canvas：底层提供一个判别联合的 `apply_ops`，上层提供 `create_image_prompt_flow`、`run_generation` 这类高层工具，减少 Agent 的调用步数和出错面。

三条工具规则：

- **按能力定义工具，不按模型。** 只有一个 `generations.create(capability, model?, ...)`，模型是参数，受注册表约束。不做"一个模型一个工具"——模型一多，工具清单就会膨胀，换模型还要改工具〔反例：Jaaz〕。Agent 通过 `models.list(capability)` 查询可用模型和能力。
- **工具只声明一次。** 工具定义（名称、schema、权限、成本类别、副作用类别）放在 `packages/agent-tools`，平台托管的 Agent 和远程 MCP 都从这份声明生成，不维护两份〔参考：ArcReel〕。
- **确定性操作交给工具，不让模型自由生成。** 读写画板、创建任务、查询状态、布局、合成都是工具；模型只负责决策和内容。

所有工具调用都带稳定的 `tool_call_id`，Tool Gateway 逐次校验租约、租户、权限、schema、预算和幂等（ADR-0001）。

#### 6.3.5 用户自带 Agent（BYO Agent）

- 对外提供远程 MCP 端点 `/mcp`，用 OAuth 授权，令牌限定项目、工具集、预算和有效期。
- 用户在自己电脑上的 Codex 或 Claude Code 里添加这个 MCP 后，就能操作云端 Board。Agent 的算力和 token 由用户承担，生成费用仍然从平台积分扣。
- 写操作照样走 Proposal，网页端可以确认，和平台托管的 Agent 一样。

#### 6.3.6 编排结构与轨迹

- **主 Agent 加聚焦子 Agent。** 主 Agent 负责判断当前状态、选择下一步、调用确定性工具、分派子 Agent、在需要时等用户确认。子 Agent 各管一件事（例如分镜拆分、文案、资产生成、审图），大段原始材料和中间推理留在子 Agent 内部，只把摘要和结果引用交回主 Agent，避免主上下文膨胀〔参考：ArcReel、Toonflow、Jaaz〕。
- **创作流程用技能描述**：例如"商品套图"、"海报系列"、"短视频分镜"，每个技能写明阶段、每阶段的评审门槛和需要用户确认的节点。它和 Recipe 的区别是：Recipe 由代码执行，技能由 Agent 执行；技能里的预算和门槛同样由控制面强制。
- **轨迹落库**：每一步的观察（画布摘要的哈希）、动作（工具调用）、结果、成本都记进 `agent_trajectories`。它用于排查问题、建评测集和比较不同 Agent 宿主〔参考：JarvisHub〕。

## 7. 画布、资产与可编辑性

### 7.1 Board 上的生成节点

- 新增 Board 条目 `generation`：显示提示词摘要、模型、参数，以及 1 到 N 个产物缩略图。点开就是参数面板，可以修改后运行（产生一个新的子生成）。
- **谱系连线**：输入素材 → generation → 产物，用 tldraw binding 实现。删除连线不删除谱系记录；谱系以 `generations` 为准，Board 只是视图（延续 AD-01）。
- 方案组（`result_group`）继续承载 Artboard 候选；位图产物可以拖进 Artboard 成为图层。

### 7.2 资产库

- **内容寻址**：用 sha256 去重，生成多种渲染副本（缩略图、预览、原图）。
- **自动标注**：ingest 后异步调用 `vision.analyze` 生成标签、主色、主体描述。之后引入向量检索（pgvector）来做"相似图"和语义搜索 [假设：评估 pgvector 在国内托管 PostgreSQL 上是否可用]。
- **生成历史**就是 `generations` 的列表视图，可以按模型、能力、项目、时间筛选，可以从任意一条"再次生成"。
- 使用权：`assets.rights` 记录上传方声明；生成产物记录模型来源和服务协议版本。

### 7.3 位图转可编辑

`image.decompose`（图层分解）、`image.cutout`（抠图）、OCR 识别文字 → `doc-core` 组装成 Artboard v1。文字变成真实文字节点，可以修改。这条链路是 Design X 的差异化能力，放在 G2 阶段。

### 7.4 画布上的编辑实体

局部重绘、扩图、区域引导需要在画布上画蒙版、框选区域。这些是**一等实体**，不是临时的界面状态：蒙版、控制图、参考区域各自是 Board 上可保存、可复用的对象，作为输入素材进入 generation 的 `inputs`（role 为 `mask`、`reference` 等）〔参考：InvokeAI `controlLayers`〕。实现上用 tldraw 自定义 shape 加离屏 canvas 绘制蒙版 [假设：G2 前做 spike]。

### 7.5 产物时效

一张图或一个 Artboard 被下游使用之后，上游可能又改了（例如 Artboard 改了文案，用它导出的参考图已经生成了视频）。规则如下〔参考：ArcReel ADR 0062〕：

- **写入时只记事实，读取时再推导结论**：每个派生产物登记它所依据的上游版本和内容摘要；"是否过时"在读取时对比当前上游推导出来，不在上游变更时去回写下游。
- **过时（stale）不等于不可用**：过时产物照样可以查看、使用、导出，界面只提示"上游已更新"，并提供"按新内容重新生成"。
- **四种状态分开**：产物时效、生成状态、批量准入结论、单条执行结果，各自独立，不混成一个字段。

## 8. 异步、事件与实时

- `jobs` 是业务状态机，pg-boss 负责投递，两者在同一事务内写入（Part 5 §E.5）。
- 事件统一走 outbox，SSE 带游标补发。新增 `generation.*` 事件族：`created / progress / output.ready / completed / failed`。
- 视频这类长任务（分钟级）要支持离开页面后的站内通知；回调要验签，并且以轮询兜底。
- 队列按能力和供应商分开，避免视频任务拖慢生图。pg-boss 吞吐的瓶颈阈值在 G1 压测中实测 [假设]。

## 9. 安全、多租户与合规

| 主题 | 设计 |
|---|---|
| 租户隔离 | workspace 为租户；应用层 `authz.can()` 加 PostgreSQL RLS（Part 5 §E.3） |
| 凭证 | 模型 Key、E2B 管理凭证、对象存储主凭证只在控制面；沙箱拿到的是绑定运行的能力令牌；模型凭证由出站代理注入（现有实现） |
| 沙箱网络 | 入站私有；出站只允许模型端点和 Tool Gateway |
| 插件 | 吸取 infinite-canvas 的教训：它的模型插件用 `new Function`、节点插件用动态 `import()`，都直接跑在主页面。多租户平台里这等于 XSS。插件必须跑在隔离的 iframe 或 Worker 里，通过 postMessage 加能力白名单通信；模型适配一律在服务端声明式注册 |
| 审核 | 文本输入、参考图、生成产物都要审核；分级处置（拦截、打码、人工复核）；审核结果写进 `moderation_events` |
| AI 标识 | 隐式标识写进文件元数据，显式标识在界面和导出时标注，按 GB 45438-2025 实现 [待定：取得标准全文] |
| 备案 | 生成式 AI 服务和算法备案，以及所用模型的备案信息公示 [假设：法务确认] |
| **数据地域** | 用户素材和生成内容是否允许出境，决定沙箱和模型的选型。**这是 G0 的首要验证项（§13）** |

## 10. 计量、配额与计费

- **积分模型**：用户看到的是积分，内部同时记录人民币成本。价格表版本化（`price_books`），每次生成记录所用的价格版本。
- 流程是预估、预留、结算、返还，账本只追加（Part 5 §E.7）。**提交前在界面上显示预估积分。**
- **结算有第三种结果：冻结。** 供应商是否受理不确定时，预留进入 `held`，对账后再扣或返还（§5.4）。
- **成本价和售价分开记**：`model_calls` 记供应商成本（人民币），账本记用户积分；价格表里同时配置两者，毛利可以按模型统计〔参考：Toonflow〕。
- Agent 回合单独计量：LLM token、沙箱时长、工具触发的生成分别记账，汇总到 turn。
- 防滥用：新账号限额、并发上限、异常速率检测、全局成本熔断。

## 11. 可观测性与质量

| 维度 | 指标 |
|---|---|
| 链路 | 一个 trace 贯穿 API → job → adapter → 供应商；`model_calls` 记录耗时、成本和请求哈希 |
| 体验 | 首图耗时（TTFI）、排队时长、取消率 |
| 可靠性 | 分模型的成功率、各类错误占比、重试率、对账修复数 |
| 成本 | 单张、单秒视频、单个 Agent 回合的成本，按模型和套餐分别统计 |
| 质量 | 隐式反馈（下载、收藏、再次生成、删除）、评估器分数、固定评测集的回归结果 |
| 合规 | 输入和输出的拦截率、人工复核积压 |

新模型上线流程：`candidate` → 内部评测集 → 小流量灰度（用户主动选择）→ `active`。没有隐式切换。

## 12. 部署拓扑（目标）

```mermaid
flowchart LR
  CDN["CDN"] --> Web["静态前端"]
  CDN --> APIc["API ×N"]
  APIc --> PGm[("托管 PostgreSQL<br/>主 + 只读副本")]
  APIc --> OSSb[("对象存储")]
  PGm --> GenW["gen-worker 池<br/>按能力分队列"]
  PGm --> MedW["media-worker 池"]
  PGm --> AgW["agent-dispatcher"]
  PGm --> Rnd["renderer 池"]
  GenW --> Prov["模型供应商（国内区域）"]
  AgW --> SBX["沙箱池<br/>自托管 E2B 或国内替代 [待定]"]
  SBX --> TGW["Tool Gateway（API 内）"]
  GenW -.成本触发后.-> GPU["GPU 池 / ml-worker"]
```

按 Part 5 §E.2.3 的触发条件拆分服务。首个拆出的大概率是 gen-worker（按能力扩缩），其次是 Tool Gateway 和远程 MCP（独立暴露面）[假设]。

### 12.1 技术选型总表

"现有"指 2026-11-08 仓库里已经在用的依赖；其余是提议，按阶段引入。

| 层 | 组件 | 选型 | 状态 |
|---|---|---|---|
| 前端 | 框架 | React 19 + Vite + TypeScript | 现有 |
| 前端 | Board 画布 | tldraw 5.6.0（生产环境需商业许可，见 Part 10 Q5） | 现有 |
| 前端 | Artboard 编辑与渲染 | React DOM/SVG，编辑、缩略图、导出共用一套（AD-04） | 现有 |
| 前端 | 蒙版与区域编辑 | tldraw 自定义 shape + 离屏 canvas（§7.4） | G2 提议 |
| 前端 | 视频时间线 | G4 评估：自研轻量时间线，或 Remotion（公司使用的许可条款待核验） | G4 待定 |
| 接入 | API | Fastify 5 + Zod 4，REST + SSE | 现有 |
| 接入 | 远程 MCP | `@modelcontextprotocol/sdk`（TypeScript），OAuth 范围令牌 | G3 提议 |
| 编排 | 任务队列 | pg-boss 12，加 `jobs` 业务状态机 | 现有 |
| 编排 | 工作流引擎 | 满足 §6.2 触发条件后评估 Temporal、Restate、DBOS | 待定 |
| 编排 | Agent 宿主 | Codex app-server（主适配器）；`codex exec`（现状）；Claude Agent SDK 等作为备选适配器 | G3 提议 |
| 编排 | 沙箱 | E2B 2.62（现有）→ 自托管 E2B 或国内替代（`SandboxProvider`） | G0 待定 |
| 能力 | 生成网关 | `packages/generation`，进程内库 | G1 提议 |
| 能力 | 图片和视频模型 | 国内供应商（如火山方舟 Seedream 和 Seedance、通义万相、可灵、Vidu 等），逐个核实开通状态、价格和备案 | G0 待定 |
| 能力 | 自托管生成 | ComfyUI 独立服务 + 模型亲和调度 + 版本化部署；`ml-worker`（Python） | 成本触发 |
| 能力 | 媒体处理 | sharp/libvips（现有）；FFmpeg（G4） | 现有 / G4 |
| 能力 | 导出渲染 | Playwright + Chromium | 现有 |
| 能力 | 审核 | 云厂商内容安全服务 | G1 待定 |
| 数据 | 数据库 | PostgreSQL + Drizzle ORM，开启 RLS | 现有 |
| 数据 | 向量检索 | pgvector（需确认托管 PostgreSQL 是否支持） | G2 评估 |
| 数据 | 对象存储 | S3 兼容（本地 SeaweedFS，线上云对象存储）+ CDN | 现有 |
| 横切 | 可观测 | OpenTelemetry；`model_calls`、`agent_trajectories` | G1 提议 |
| 工程 | Monorepo | pnpm + turbo；依赖方向用 lint 规则强制（核心领域包不依赖 HTTP 框架和 Agent SDK）〔参考：ArcReel import-linter〕 | 现有 / 提议 |

## 13. 现状差距

| 领域 | 现状（2026-11-08 代码） | 目标 | 差距 |
|---|---|---|---|
| 生图 | 无。`gen.image`、`ImageAdapter`、注册表都只在文档里 | 生成网关加至少 1 个国内图片模型 | **大** |
| 生成记录与谱系 | 只有 `assets.provenance` 的设计 | `generations`、`generation_outputs`、`asset_lineage` | **大** |
| Agent 宿主 | `codex exec`，每轮一个新沙箱和新 thread | `AgentRuntime` 加 app-server 适配器，会话级沙箱 | 中 |
| 工具桥 | 没有业务工具，Agent 用 shell 写 `artifact.json` | 控制面 Tool Gateway 通过 MCP 暴露 | 中 |
| 产物校验与提交 | 已有：manifest 校验、Proposal、版本 CAS、fencing | 保留，并扩展到工具产物 | 小 |
| 控制面基础 | 已有：PostgreSQL、pg-boss、对象存储、SSE、Renderer | 保留 | 小 |
| 计量与审核 | 只有设计 | 账本、价格表、审核适配器 | 大 |
| 部署地域 | E2B 云服务（海外托管） | 符合数据地域要求的沙箱 | **未验证，风险最高** |

## 14. 演进路线

和 Part 10 的 M 系列里程碑并行，这条是"AI 地基"轨道。每个阶段都有退出条件。

| 阶段 | 范围 | 退出条件 |
|---|---|---|
| **G0 地基验证**（2–3 周） | ① 沙箱地域：在目标云上自托管 E2B，或选定国内替代，用 `SandboxProvider` 接口跑通现有 Harness；② 选定 1 个国内图片模型并核实开通状态、价格、备案；③ `generations` 和谱系的 schema 评审 | 地域方案 go/no-go；模型可调用；本文档相关部分转为 ADR |
| **G1 生成闭环** | 生成网关、1 个模型、直接生成、Board 生成节点、生成历史、输入输出审核、积分账本、SSE 进度 | 端到端：提交 → 审核 → 生成 → 转存 → 标识 → 上画布 → 再次生成和派生；故障注入（超时、429、审核拦截、Worker 重启）都通过 |
| **G2 编辑与可编辑化** | 局部重绘、扩图、高清、抠图、图层分解转 Artboard；第 2 个供应商；Recipe 改为调用网关 | 同一能力两个供应商通过同一套契约测试；位图转可编辑的验收集 |
| **G3 Agent 平台化** | `AgentRuntime` 接口；把 `codex-exec` 包成适配器；Tool Gateway 加 MCP；app-server 适配器通过 §6.3.2 的四个场景；会话级沙箱；远程 MCP（BYO Agent） | 切换 ADR 获批；两种宿主共用一份工具定义；预算和审批生效 |
| **G4 视频与长流程** | `video.*` 能力、分镜文档、长任务通知、FFmpeg 链路；评估是否需要工作流引擎 | 30 分钟级任务的取消、恢复、对账、部分结果都能验证 |
| G5 及以后 | 团队协作、模板和技能市场、社区作品、自托管模型 | 按产品证据和成本触发 |

**顺序的关键**：G0 先于一切；G1 先于 G3。Agent 层在生成网关就位之后再平台化，这时它只是替换适配器、接上工具，不再牵动地基。

## 15. 待立决策（提议）

| ID | 决策 | 状态 |
|---|---|---|
| AD-14 | 生成网关加 `generations` 一等记录；generation 与 job 分离；谱系物化 | 提议 |
| AD-15 | `AgentRuntime` 接口加 MCP Tool Gateway；Codex app-server 为主适配器（修订 ADR-0001） | 提议，**需用户决策** |
| AD-16 | 沙箱与模型的部署地域；`SandboxProvider` 接口 | 待定（G0 验证） |
| AD-17 | 远程 MCP 对外开放（BYO Agent） | 提议 |
| AD-18 | 插件隔离：前端插件只能在 iframe 或 Worker 里运行；模型适配只在服务端注册 | 提议 |
| AD-19 | Agent 会话以业务上下文为真相源；原生 thread 只作缓存；会话命令串行化 | 提议 |
| AD-20 | 生成恢复规则：任务 ID 先落库；孤儿生成不自动重新提交；结果未知时冻结结算；提交前写检查点并物化参考素材 | 提议 |
| AD-21 | 编辑即分叉；产物时效"写时记事实、读时算结论" | 提议 |
| AD-22 | Agent 工具按能力定义、只声明一次，内嵌 Agent 和远程 MCP 共用 | 提议（并入 AD-15 也可） |

## 16. 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 沙箱或模型地域不合规 | 执行层重做 | G0 最先验证；有 `SandboxProvider` 接缝 |
| Codex 上游协议变化（`experimental` 字段、配置项） | Agent 层中断 | 固定版本；契约测试；`AgentRuntime` 可替换 |
| 非 OpenAI 模型在 Codex 上的工具调用质量不稳 | Agent 效果差 | 固定评测集；必要时更换 Agent 宿主，工具不变 |
| 供应商下线或改价 | 历史生成无法重放，成本失控 | 注册表版本化、价格表版本化、显式替代提示 |
| 生成成本被滥用 | 账单失控 | 预留式扣费、并发限额、熔断 |
| 谱系模型设计不足 | 后期补派生能力时要迁移数据 | G0 评审 schema，覆盖 §6.1 全部派生类型 |
| pg-boss 吞吐瓶颈 | 高峰排队变长 | G1 压测；按能力分队列；预留迁移到专用队列的接缝 |
