# Part 2 · 架构图（交付物 B）

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

  llm["LLM API<br/>豆包 / 通义千问 / DeepSeek<br/>（国内已备案模型）"]
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
    aiw["AI 执行<br/>ai.turn、recipe.run"]
    genw["生成与媒体<br/>gen.image、media.ingest、media.process"]
    rend["渲染<br/>render.export、render.thumbnail"]
  end

  pg[("PostgreSQL<br/>业务数据、op-log、快照、<br/>队列、outbox")]
  obj[("对象存储 + CDN")]
  prov["外部模型与审核 API"]

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
  aiw -->|"typed tools（进程内调用领域服务）"| pg
  aiw --> prov
  genw --> prov
  genw --> obj
  rend --> obj
  pg -.->|LISTEN/NOTIFY → SSE| gw
```

**说明**

- **真相源**：业务数据和文档都在 PostgreSQL，二进制都在对象存储。浏览器 IndexedDB 只是缓存和离线队列；Worker 不保存任何长期状态。
- Worker 与 API **共享同一套领域服务代码**，作为 TS 包按进程引用。所以 Agent 工具调用就是进程内函数调用，并且经过与 HTTP 请求相同的授权检查（`AuthzContext`）。
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
  entry1["Chat 消息<br/>POST /v1/ai/sessions/:id/turns"]
  entry2["技能表单直接生成<br/>POST /v1/recipes/:id/runs"]
  entry3["直接工具<br/>抠图 / 改尺寸 / 导出"]

  subgraph Guard["安全控制（前置）"]
    q1["配额与预算检查"]
    m1["输入审核<br/>文本 + 参考图"]
  end

  subgraph Runtime["packages/ai-runtime（在 Worker 的 ai.turn 队列执行）"]
    loop["AgentLoop<br/>LLM 工具调用循环<br/>步数 / 预算 / 时间上限"]
    ctx["ContextBuilder<br/>摘要 + 最近消息 + 文档描述 + 预览图"]
    reg["ToolRegistry<br/>zod schema、授权、计量"]
    rec["RecipeEngine<br/>确定性步骤 DAG"]
    evalr["Evaluators<br/>OCR / 视觉一致性 / 文字溢出"]
  end

  subgraph Tools["Typed Tools（只能调用领域服务）"]
    t1["board.describe / artboard.describe"]
    t2["artboard.render_preview"]
    t3["assets.search / assets.inspect"]
    t4["recipes.run"]
    t5["images.generate / images.edit / images.cutout"]
    t6["artboard.create_from_template / artboard.create_version"]
    t7["artboard.propose_ops"]
    t8["board.place_items"]
    t9["jobs.await"]
    t10["ask_user"]
  end

  subgraph Prov["packages/providers"]
    capreg["CapabilityRegistry<br/>模型能力 / 限制 / 区域 / 单价"]
    llmA["LLM 适配器"]
    imgA["Image 适配器"]
    modA["Moderation 适配器"]
  end

  outm["输出审核 + AI 标识<br/>（media.ingest 阶段）"]
  docs[("documents / assets / jobs")]

  entry1 --> Guard --> loop
  entry2 --> Guard --> rec
  entry3 --> Guard
  loop --> ctx
  loop --> reg --> Tools
  loop --> llmA
  t4 --> rec
  rec --> llmA
  rec --> t5
  t5 -->|入队 gen.image| docs
  Tools --> docs
  evalr --> imgA
  rec --> evalr
  loop --> evalr
  llmA --> capreg
  imgA --> capreg
  docs --> outm --> modA
  m1 --> modA
```

**说明**

- 三种入口共用同一套 `recipes`、`jobs` 和 `documents` 服务。“技能表单直接生成”与“对话中由 Agent 选择配方”最终执行的是**同一份配方定义**，这是 DOCX“统一任务入口”建议的落地方式。
- 工具**只能**调用领域服务；没有任何工具能执行代码、访问文件系统或拿到供应商密钥。
- 预算在工具层强制执行（代码层），不靠提示词约束。

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
  wk --> ext["外部模型与审核 API"]
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
```

拓扑变化的触发条件见 Part 6 §F.11。

---

## B.8 数据流与信任边界

```mermaid
flowchart LR
  subgraph TB0["信任区 0：不可信"]
    browser["用户浏览器<br/>任意输入、文件、提示词"]
    provOut["供应商返回内容<br/>图片、视频、URL、文本"]
  end

  subgraph TB1["信任区 1：边界服务"]
    apiE["api：认证、校验、限流、幂等"]
    cbE["回调端点：签名校验"]
  end

  subgraph TB2["信任区 2：内部可信"]
    dom["领域服务 + authz"]
    agent["Agent 循环<br/>LLM 输出视为不可信指令"]
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
  agent -->|"仅限 typed tools，项目范围授权"| dom
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
4. **密钥**：只有 Worker 和 API 能读 KMS，Agent 上下文里永远不出现密钥或预签名 URL。

---

## B.9 仓库包依赖图（允许的依赖方向）

```mermaid
flowchart TB
  subgraph Apps["apps（可部署单元）"]
    web["apps/web"]
    api["apps/api"]
    worker["apps/worker"]
    renderer["apps/renderer"]
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
