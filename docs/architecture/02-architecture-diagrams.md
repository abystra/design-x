# Part 2 · 架构图（交付物 B）

以下图包含最终 AI 目标，AI 路径尚未实现或验证；当前先落地非 AI 控制面与创作链路。E2B 内 Harness + Codex SDK 已由用户确认，见 [ADR-0001](../adr/0001-codex-e2b.md)。

本部分的组件名、模块名、队列名和包名，与 Part 4–8 保持一致。权威命名见 Part 8 §H.2（包）、Part 5 §E.2（模块）和 Part 7（表、事件、API）。

---

## B.1 系统上下文与外部依赖

```mermaid
flowchart TB
  user["创作者<br/>浏览器（桌面优先）"]
  admin["运营 / 审核人员<br/>（内部后台，Phase 2）"]

  subgraph DX["Design-X 平台（本方案范围）"]
    web["Web 应用"]
    core["控制面 API + Worker + Renderer"]
  end

  llm["配方 / 评估器 LLM API<br/>能力注册表配置"]
  sbx["E2B Sandbox<br/>Harness + Codex SDK（后续）"]
  codex["已配置的 Codex 模型服务<br/>账号 / 区域待验证"]
  img["图像模型 API<br/>Seedream / Qwen-Image 等"]
  vid["视频模型 API（Phase 3）<br/>Seedance / 万相 / 可灵 等"]
  mod["内容安全 API<br/>阿里云 / 火山引擎"]
  sms["短信 / 邮件服务"]
  cloud["云基础设施<br/>托管 PostgreSQL、OSS/TOS、CDN、KMS、日志"]
  tl["tldraw 许可证密钥<br/>（仅前端本地校验，无运行时服务依赖）"]

  user --> web
  admin -.-> web
  web <--> core
  core --> llm
  core -.->|调度 / 受限业务桥接| sbx
  sbx -.-> codex
  core --> img
  core -.-> vid
  core --> mod
  core --> sms
  core --> cloud
  web --> cloud
  web -.-> tl
```

**说明**

- 所有模型调用都**只从服务端发起**，浏览器拿不到任何供应商密钥。
- 浏览器只为两件事直接访问云：通过**预签名 URL** 上传和下载对象，以及读取 CDN 上的缩略图和字体。
- tldraw 的许可证密钥按官方文档在本地解码校验，不访问许可服务器 [二手：官方文档摘录]。但 LICENSE 原文写明软件“可能为合规目的传输使用数据” [已核验]，M0 需抓包确认浏览器端是否有外呼（见 Part 4 §D.2.6）。
- 视频供应商是 Phase 3 依赖（虚线）。

---

## B.2 总体逻辑架构

```mermaid
flowchart LR
  subgraph Client["浏览器：apps/web"]
    shell["App Shell<br/>导航 / 项目 / 素材库 / 技能目录"]
    ws["AI 工作区"]
    chat["AI Chat 面板"]
    board["Board<br/>BoardEngine 适配层"]
    editor["Artboard Editor"]
    docc["Doc Client<br/>doc-core + ops 队列"]
  end

  subgraph API["apps/api（模块化单体）"]
    gw["HTTP / SSE 网关<br/>认证、限流、幂等"]
    mods["领域模块<br/>identity、projects、assets、documents、<br/>ai、recipes、jobs、exports、quotas、<br/>moderation、audit、fonts"]
  end

  subgraph Workers["apps/worker、apps/renderer"]
    aiw["AI 调度 / 确定性配方<br/>ai.turn、recipe.run（后续）"]
    genw["生成与媒体<br/>gen.image、media.ingest、media.process"]
    rend["渲染<br/>render.export、render.thumbnail"]
  end

  pg[("PostgreSQL<br/>业务数据、op-log、快照、<br/>队列、outbox")]
  obj[("对象存储 + CDN")]
  prov["配方 / 图像模型与审核 API"]
  sandbox["E2B：Harness + Codex SDK<br/>受限工作区（后续）"]

  ws --- chat
  ws --- board
  ws --- editor
  board --> docc
  editor --> docc
  chat --> gw
  docc --> gw
  shell --> gw
  gw --> mods
  mods --> pg
  mods -->|预签名| obj
  pg -->|pg-boss 队列| aiw
  pg -->|pg-boss 队列| genw
  pg -->|pg-boss 队列| rend
  aiw -->|运行关联 / 租约| pg
  aiw -.->|生命周期调度| sandbox
  sandbox -.->|受限业务工具 / 进度 / 成果| gw
  aiw --> prov
  genw --> prov
  genw --> obj
  rend --> obj
  pg -.->|LISTEN/NOTIFY → SSE| gw
```

**说明**

- **真相源**：业务数据和文档都在 PostgreSQL，二进制都在对象存储。浏览器 IndexedDB 只是缓存和离线队列；Worker 本地状态不作为恢复依据；沙箱及 SDK 状态只是执行状态，业务恢复依赖已持久化记录。
- Worker 与 API **共享同一套领域服务代码**，作为 TS 包按进程引用。Harness 经受限 HTTP/MCP 工具桥接请求领域服务，不能在沙箱内引用领域包或直接写库；桥接执行相同的授权检查（`AuthzContext`），并校验运行身份、租约和幂等键。
- 实时性：领域事务写入 `outbox` 表，`NOTIFY` 唤醒 API 进程，再经 SSE 推给订阅该项目的浏览器。

---

## B.3 前端架构

```mermaid
flowchart TB
  subgraph Shell["App Shell（React 19 + TS + Vite）"]
    router["Router<br/>TanStack Router"]
    pages["页面：首页 / 技能 / 工具 / 模板 / 项目 / 资产"]
    wsroute["/p/:projectId 工作区路由"]
  end

  subgraph WS["AI 工作区"]
    chatui["ChatPanel<br/>消息流、技能选择、@素材、回合状态"]
    boardui["BoardView"]
    editorui["ArtboardEditor（聚焦模式覆盖层）"]
    assetui["AssetPanel / SkillPanel"]
  end

  subgraph BoardLayer["packages/board"]
    engine["BoardEngine 接口"]
    tla["TldrawBoardAdapter<br/>自定义 shape：dx-artboard、dx-asset、<br/>dx-result-group、dx-note"]
    doma["DomBoardAdapter（保底）"]
  end

  subgraph EditorLayer["packages/artboard-editor"]
    sel["选择 / 变换控件<br/>Moveable + Selecto"]
    text["文字编辑<br/>contenteditable + IME"]
    props["属性 / 图层面板"]
    hist["History：inverse-op 栈"]
  end

  render["packages/doc-render<br/>ArtboardRenderer（DOM/SVG）"]
  core["packages/doc-core<br/>schema、ops、迁移、校验（纯 TS）"]

  subgraph State["状态分层"]
    ui["UI 状态：Zustand<br/>选中、面板、视口、工具"]
    doc["文档状态：DocStore<br/>head + 本地待提交 ops"]
    srv["服务端缓存：TanStack Query<br/>项目、素材、任务、会话"]
    idb["IndexedDB<br/>离线 op 队列、文档缓存"]
  end

  sse["EventStream（SSE）<br/>document.* / job.* / ai.*"]
  apic["api-client（OpenAPI 生成）"]

  router --> pages
  router --> wsroute --> WS
  boardui --> engine
  engine --> tla
  engine --> doma
  tla --> render
  doma --> render
  editorui --> EditorLayer
  EditorLayer --> render
  render --> core
  doc --> core
  boardui --> doc
  editorui --> doc
  chatui --> srv
  assetui --> srv
  doc --> idb
  doc --> apic
  srv --> apic
  sse --> doc
  sse --> srv
```

**说明**

- `doc-core` 不依赖 DOM 和 React，浏览器、API 和 Worker 用的是同一份操作语义。
- `doc-render` 是 **Artboard 的唯一渲染实现**，被编辑器、Board 上的 Artboard shape（高 LOD）和服务端 Renderer 共同使用。
- Board 的 tldraw store 是**视图模型**：持久化与同步以 `doc-core` 的 Board 文档为准（Part 4 §D.2.4）。

---

## B.4 后端领域模块与服务边界

```mermaid
flowchart TB
  subgraph Edge["apps/api 边界层"]
    http["REST /v1（Fastify）"]
    ssegw["SSE /v1/projects/:id/events"]
    cb["Provider Callbacks /v1/providers/callbacks/:provider"]
    bridge["内部运行桥接（后续）<br/>工具 / 事件 / 成果；运行身份 + 租约"]
  end

  subgraph Domain["领域模块（packages/server-domain，API 与 Worker 共享）"]
    identity["identity<br/>用户、会话、登录"]
    tenancy["workspaces<br/>租户、成员、角色"]
    projects["projects<br/>项目、文件夹"]
    authz["authz<br/>策略检查 + RLS 上下文"]
    assets["assets<br/>上传、ingest、渲染副本、引用、GC"]
    documents["documents<br/>Board/Artboard、ops、快照、版本、proposal"]
    ai["ai<br/>会话、消息、回合、工具调用"]
    recipes["recipes<br/>技能目录、配方、模板"]
    jobs["jobs<br/>任务、状态机、重试、对账"]
    exports["exports<br/>导出请求与产物"]
    quotas["quotas<br/>配额、用量账本、成本"]
    moderation["moderation<br/>审核、AI 标识"]
    audit["audit<br/>审计日志"]
    fonts["fonts / brand<br/>字体注册、品牌套件"]
    events["events<br/>outbox、事件分发"]
  end

  subgraph Adapters["基础设施适配器"]
    store["ObjectStore（S3 兼容）"]
    queue["Queue（pg-boss）"]
    providers["packages/providers<br/>LLM / Image / Video / Moderation"]
  end

  http --> authz
  bridge --> authz
  ssegw --> authz
  cb --> jobs
  authz --> projects
  projects --> documents
  projects --> assets
  ai --> recipes
  ai --> documents
  ai --> jobs
  recipes --> jobs
  recipes --> documents
  jobs --> providers
  jobs --> assets
  exports --> jobs
  assets --> moderation
  jobs --> quotas
  ai --> quotas
  documents --> events
  jobs --> events
  ai --> events
  assets --> store
  jobs --> queue
  identity --> tenancy
  audit -.- http
```

**边界规则**

- 每个模块对外只暴露 `service` 接口与领域事件，**不允许跨模块直接写表**。例如 `ai` 修改文档必须调用 `documents.applyOps()` 或 `documents.createProposal()`。
- `authz` 是所有入口（HTTP、SSE、Worker 工具调用）的必经层。
- 拆分为独立服务的触发条件见 Part 5 §E.2.3。

---

## B.5 AI 运行时：技能/配方、工具调用、供应商与安全控制

```mermaid
flowchart TB
  chat["Chat → API：回合请求（后续）"]
  form["技能表单 → API：recipe 请求"]
  direct["确定性操作：裁剪 / 改尺寸 / 导出"]
  guards["控制面：认证 / 项目权限 / 预算 / 输入校验"]
  scheduler["Worker / ai-runtime<br/>租约、E2B 生命周期、恢复、取消"]
  subgraph E2B["E2B Sandbox：不可信执行环境（后续）"]
    harness["apps/harness<br/>受限上下文 / 事件 / 成果 manifest"]
    sdk["Codex SDK<br/>本地 thread / 代码 / 文件执行"]
  end
  bridge["控制面 ToolBridge<br/>运行身份 / schema / 租约 / 幂等 / 权限"]
  recipe["RecipeEngine<br/>版本化确定性步骤"]
  domain["业务服务<br/>documents / assets / jobs / quotas"]
  provider["配方 / 图像 / 评估 / 审核适配器"]
  ingest["成果摄取<br/>校验文件 + ops / Proposal"]
  events["持久化事件 → outbox → SSE"]
  data[("PostgreSQL / S3 业务真相源")]
  model["Codex 已配置模型服务"]

  chat --> guards --> scheduler
  form --> guards --> recipe
  direct --> guards --> domain
  scheduler -.->|创建 / 重连 / 暂停 / 销毁| harness
  harness --> sdk --> model
  harness -->|受限业务请求| bridge --> domain
  bridge --> recipe --> domain
  recipe --> provider
  harness -->|运行事件| events
  harness -->|临时成果| ingest --> domain
  domain --> data
  domain --> events
```

**说明**

- 三种入口共用领域服务；固定 recipes 仍在控制面执行，不由沙箱改写定义。
- Codex 可以在沙箱内操作代码与文件；业务工具不提供任意 SQL、存储主凭证或跨项目写入。沙箱不能直连数据库，所有正式成果由控制面校验后提交。
- 预算、租约、审批与幂等在控制面强制；SDK 状态和 E2B 状态不代替任务状态。暂停/恢复与业务续跑分别验证。

---

## B.6 异步任务与媒体处理

```mermaid
flowchart LR
  subgraph Producers["生产者"]
    apiP["API 请求"]
    agentP["Agent 工具 / Recipe 步骤"]
    cronP["定时任务<br/>job.reconcile、asset.gc"]
  end

  subgraph PG["PostgreSQL"]
    jobsT[("jobs 表<br/>业务状态机")]
    boss[("pg-boss 队列表<br/>投递 / 重试 / 延迟")]
    outbox[("outbox 表")]
  end

  subgraph W["Worker 进程"]
    gen["gen.image<br/>提交 + 同步等待或轮询"]
    poll["gen.poll<br/>异步供应商轮询（指数退避）"]
    ingest["media.ingest<br/>下载 → 校验 → 重编码 → 渲染副本 → 审核 → 标识"]
    proc["media.process<br/>sharp/libvips：缩放、裁剪、格式"]
    cut["media.cutout<br/>抠图（供应商 API；后续自托管）"]
  end

  subgraph R["Renderer 进程"]
    exp["render.export<br/>Chromium + doc-render"]
    thumb["render.thumbnail<br/>Artboard 缩略图 / LOD"]
  end

  prov["供应商 API"]
  obj[("对象存储")]
  cbk["供应商回调（如支持）"]

  apiP --> jobsT
  agentP --> jobsT
  cronP --> jobsT
  jobsT -->|同一事务入队| boss
  boss --> gen
  boss --> poll
  boss --> ingest
  boss --> proc
  boss --> cut
  boss --> exp
  boss --> thumb
  gen --> prov
  poll --> prov
  cbk --> jobsT
  gen -->|成功| ingest
  poll -->|成功| ingest
  ingest --> obj
  proc --> obj
  cut --> obj
  exp --> obj
  thumb --> obj
  gen --> jobsT
  ingest --> jobsT
  exp --> jobsT
  jobsT --> outbox
```

**说明**

- `jobs` 表是**业务状态机**（用户可见、可审计）；pg-boss 只负责**投递**（at-least-once、重试、延迟）。这样把“任务是什么状态”和“消息有没有被处理”分开，换队列实现不影响业务语义。
- 每个处理器都**幂等**：以 `jobs.id + stage` 作为幂等键，产物对象键是确定的，例如 `assets/{asset_id}/original`。
- 供应商输出 URL **一拿到就转存**到自有存储（Part 5 §E.6）。

---

## B.7 部署架构

### B.7.1 MVP（China-first，临时方案）

```mermaid
flowchart TB
  dns["域名（ICP 备案）"] --> cdn["CDN<br/>静态资源、字体、缩略图"]
  dns --> slb["负载均衡 / Ingress（HTTPS）"]

  subgraph Region["单区域，例如华东（2 个可用区）"]
    subgraph Compute["容器运行时：2–3 台 ECS + Docker Compose，或 SAE / ACK"]
      api1["api × 2"]
      wk["worker × 2<br/>ai.turn、recipe.run、gen.*、media.*"]
      rd["renderer × 1–2<br/>Chromium、字体"]
    end
    rds[("托管 PostgreSQL 高可用版<br/>PITR 备份")]
    oss[("OSS / TOS<br/>版本控制、生命周期规则")]
    kms["KMS / 凭据管理"]
    logs["日志服务 + 指标 + Trace"]
  end

  slb --> api1
  cdn --> oss
  api1 --> rds
  wk --> rds
  rd --> rds
  api1 --> oss
  wk --> oss
  rd --> oss
  api1 --> kms
  wk --> kms
  Compute --> logs
  wk --> ext["配方 / 图像模型与审核 API"]
  wk -.->|后续：生命周期 / 运行桥接| e2b["E2B Sandbox<br/>Harness + Codex SDK<br/>区域与网络条件待验证"]
  e2b -.-> codexService["已配置的 Codex 模型服务"]
```

### B.7.2 Growth

```mermaid
flowchart TB
  edge["CDN + WAF"] --> ing["K8s Ingress"]
  subgraph K8s["托管 Kubernetes（ACK 等），Argo CD GitOps"]
    apiN["api（HPA）"]
    wkAI["worker-ai（HPA，按队列深度）"]
    wkMedia["worker-media（HPA）"]
    rdN["renderer（HPA，内存约束）"]
    collab["collab（Phase 4：Board 实时同步）"]
    wf["workflow engine（满足触发条件后：Temporal 或 Hatchet）"]
    ml["ml-worker（Python，GPU 节点池，自托管像素模型时）"]
  end
  pgp[("PostgreSQL 主 + 只读副本")]
  kv[("Valkey（满足触发条件后）")]
  objN[("对象存储 + 跨区复制")]
  obs["可观测性：OTel Collector → 指标 / 日志 / Trace + Langfuse"]

  ing --> apiN
  ing --> collab
  apiN --> pgp
  wkAI --> pgp
  wkMedia --> pgp
  rdN --> pgp
  wf --> pgp
  apiN --> kv
  collab --> kv
  wkMedia --> objN
  rdN --> objN
  ml --> objN
  K8s --> obs
  wkAI -.-> e2bN["E2B Sandbox 池<br/>Harness + Codex SDK"]
```

拓扑变化的触发条件见 Part 6 §F.11。

---

## B.8 数据流与信任边界

```mermaid
flowchart LR
  subgraph TB0["信任区 0：不可信"]
    browser["用户浏览器<br/>任意输入、文件、提示词"]
    provOut["供应商返回内容<br/>图片、视频、URL、文本"]
    agent["E2B Sandbox 内 Harness / Codex<br/>代码、工具参数、事件、成果均不可信"]
  end

  subgraph TB1["信任区 1：边界服务"]
    apiE["api：认证、校验、限流、幂等"]
    cbE["回调端点：签名校验"]
    runtimeE["运行桥接：身份 / 租约 / schema / 幂等"]
  end

  subgraph TB2["信任区 2：内部可信"]
    dom["领域服务 + authz"]
    workers["Worker / Renderer<br/>解析媒体，在隔离进程中执行"]
  end

  subgraph TB3["信任区 3：数据"]
    db[("PostgreSQL<br/>RLS：workspace_id")]
    os[("对象存储<br/>私有桶")]
    sec["KMS：供应商密钥"]
  end

  browser -->|"HTTPS + 会话 Cookie"| apiE
  browser -->|"预签名 PUT（单对象、限时、限大小、限类型）"| os
  apiE --> dom
  dom --> db
  agent -->|"受限工具 / 事件 / 成果 manifest"| runtimeE
  runtimeE --> dom
  runtimeE -->|文件摄取| workers
  workers -->|"下载、解码、重编码"| os
  provOut -->|"出站拉取（URL 白名单）"| workers
  cbE --> dom
  workers --> sec
  workers -->|"预签名 GET（5–15 分钟）"| provIn["供应商<br/>拉取参考图"]
```

**关键边界**

1. **浏览器 → 存储**：只能用预签名 URL 上传到 `uploads/` 隔离前缀。对象经 `media.ingest` 校验并重编码后才进入 `assets/`。
2. **LLM 输出 → 工具**：LLM 的工具参数一律当作不可信输入，先做 schema 校验和授权检查；工具只能访问当前会话所属项目。
3. **供应商输出 → 资产**：Worker 主动拉取，校验 MIME、尺寸、像素上限和时长，重编码后再审核；没通过审核的内容不会出现在 Board 上。
4. **密钥**：只有控制面能读数据库/对象存储/E2B 管理凭证；沙箱只有有期限、绑定运行的能力令牌。Codex 认证方案待集成验证，长期凭证不进入提示词、事件、检查点或日志。
5. **沙箱**：显式限制出站与入站；临时文件只有经过摄取才能成为资产。失效租约后的工具调用和迟到成果不能写入业务。

---

## B.9 仓库包依赖图（允许的依赖方向）

```mermaid
flowchart TB
  subgraph Apps["apps（可部署单元）"]
    web["apps/web"]
    api["apps/api"]
    worker["apps/worker"]
    renderer["apps/renderer"]
    harness["apps/harness（E2B 内，后续）"]
  end

  subgraph FE["前端包"]
    board["packages/board"]
    editor["packages/artboard-editor"]
    ui["packages/ui"]
    apiclient["packages/api-client（生成）"]
  end

  subgraph Shared["共享核心（无 DOM、无 Node 专属 API）"]
    core["packages/doc-core"]
    contracts["packages/contracts"]
  end

  render["packages/doc-render（React DOM/SVG）"]
  hc["packages/harness-client"]
  sdk["Codex SDK"]
  e2bSdk["E2B 控制面 SDK"]

  subgraph BE["后端包（仅 Node）"]
    domain["packages/server-domain"]
    airt["packages/ai-runtime"]
    recipes["packages/recipes"]
    providers["packages/providers"]
    infra["packages/server-infra<br/>db、queue、storage、telemetry"]
  end

  web --> board
  web --> editor
  web --> ui
  web --> apiclient
  web --> contracts
  board --> render
  board --> core
  editor --> render
  editor --> ui
  editor --> core
  render --> core
  apiclient --> contracts
  contracts --> core
  api --> domain
  worker --> domain
  worker --> airt
  airt --> e2bSdk
  harness --> hc
  harness --> sdk
  hc --> contracts
  renderer --> render
  renderer --> infra
  domain --> core
  domain --> contracts
  domain --> infra
  domain --> providers
  airt --> domain
  airt --> recipes
  airt --> providers
  recipes --> core
  recipes --> contracts
  providers --> contracts
```

**禁止的依赖**（用 dependency-cruiser 在 CI 中强制执行，MIT [已核验]）：

- `doc-core` 不能依赖任何包（只能依赖 `zod`）。
- 前端包不能依赖 `server-*`、`ai-runtime` 或 `providers`。
- `providers` 不能依赖 `server-domain`，因为适配器不知道业务实体。
- `recipes` 不能直接调用 `providers`，必须经 `ai-runtime` 或 `server-domain` 的任务接口，以保证计量和授权。
- 任何包都不能依赖 `apps/*`。
- `apps/harness` / `harness-client` 禁止依赖 `server-domain`、`server-infra` 或数据库驱动；沙箱只消费运行契约。
