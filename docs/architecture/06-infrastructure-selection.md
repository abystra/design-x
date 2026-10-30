# Part 6 · 中间件与基础设施选型（交付物 F）

## F.0 许可分类图例

| 代号 | 含义 | 商用注意 |
|---|---|---|
| **OSI** | OSI 认可的开源许可（MIT、Apache-2.0、BSD、MPL-2.0、LGPL、GPL、AGPL、PostgreSQL License 等） | 宽松类（MIT/Apache/BSD/PostgreSQL）基本无约束；**AGPL**：修改后通过网络向用户提供服务时需开源修改部分，原样内部使用通常无额外义务；**GPL/LGPL**：分发二进制时有义务 |
| **SA** | Source-available：代码公开但有使用限制（BSL、SSPL、RSAL、FSL、tldraw license 等） | 必须逐条读条款 |
| **Open-core** | 核心是 OSI 许可，`ee/` 目录是商业许可 | 只用 OSI 部分时需避免启用企业功能 |
| **Managed** | 云厂商托管服务 | 不涉及软件许可，涉及数据驻留与锁定 |
| **Commercial** | 商业 SDK 或服务 | 需购买 |
| **Model API** | 外部模型 API | 受服务条款、备案与数据合规约束；多数没有可替代的开源同等物 |

表中“许可”列凡标 [已核验] 的，都是本次直接读取官方仓库 LICENSE 文件或 npm 元数据所得，链接见 Part 11。

---

## F.1 关系数据库与迁移

| 项 | MVP 选择 | 许可 | 为什么合适 | 备选 | 部署与运维 | 替换或拆分触发 |
|---|---|---|---|---|---|---|
| 数据库 | **PostgreSQL 17 或 18**（托管：阿里云 RDS PostgreSQL 或火山引擎 RDS PostgreSQL） | PostgreSQL License（OSI，通识） | 事务、JSONB（文档快照）、RLS、LISTEN/NOTIFY、可同时承担队列和 outbox；托管服务提供高可用、PITR 与备份 | MySQL（无 RLS、JSON 能力弱）；PolarDB-PG（托管兼容） | 托管高可用版（主备跨可用区）；连接池用应用侧池；PgBouncer 只在连接数超过上限时引入 | 写入 QPS 持续 > 5k 或 `document_ops` 超过 5 亿行时，按 `document_id` 哈希分区，或拆出文档库 [假设] |
| 迁移 | **Drizzle Kit 生成 SQL**，SQL 文件入库评审 | Apache-2.0 [已核验] | 与 TS schema 同源，生成的 SQL 可读、可评审 | Kysely（MIT [已核验]）+ dbmate；Atlas | CI 中对临时库执行 up，并跑兼容性测试；生产迁移由发布流水线执行，遵循“只增不删”两阶段约定 | — |
| 扩展 | `pg_trgm`（模糊搜索），后续 `pgvector`、中文分词 | pgvector：PostgreSQL 风格许可 [已核验] | 托管 RDS 一般支持 [假设：核实目标云支持的扩展列表] | — | — | — |

## F.2 Redis 兼容缓存、发布订阅与限流

| 项 | MVP 选择 | 许可 | 说明 |
|---|---|---|---|
| **MVP：不引入** | 用 PostgreSQL 替代：`LISTEN/NOTIFY` 做 SSE 扇出；`rate_limit_buckets` 表做令牌桶；应用内 LRU 缓存 | — | 少一个有状态组件；MVP 流量（AS-3）完全可承受 [假设] |
| 引入后的首选 | **Valkey** | BSD-3-Clause [已核验] | Linux Foundation 维护的 Redis 分支，协议兼容 |
| 备选 | Redis 8 | **RSALv2 / SSPLv1 / AGPLv3 三选一** [已核验]；7.2 及以前版本为 BSD | 自托管时选 AGPLv3 原样使用，一般可接受，但需法务确认；托管 Redis 由云厂商负责许可 |
| 托管 | 阿里云 Tair/Redis、火山引擎缓存数据库 | Managed | 引入时优先托管 |
| **引入触发** | ①API 副本 > 4 且 NOTIFY 扇出延迟 p95 > 500ms；②限流表热点行锁等待 > 5% 请求；③引入 BullMQ 或实时协作（Phase 4） | | |

## F.3 任务队列与工作流引擎

| 项 | MVP 选择 | 许可 | 为什么 | 备选 | 运维 | 触发 |
|---|---|---|---|---|---|---|
| 任务队列 | **pg-boss**（基于 PostgreSQL，npm 12.x） | MIT [已核验] | 不需要额外组件；`SKIP LOCKED` 投递、重试、延迟、单例键、定时任务；与业务写同库 | graphile-worker（MIT [已核验]）；BullMQ（MIT [已核验]，需 Redis） | 与主库共享，注意队列表的清理（归档策略） | 队列吞吐 > 500 jobs/s，或队列表膨胀影响主库，改为 BullMQ + Valkey [假设] |
| 工作流引擎 | **MVP 不引入**；配方与回合用 `jobs` + `job_waiters` + 续跑实现 | — | MVP 工作流 ≤ 8 步，没有跨天的人工等待 | — | — | 见下行 |
| Growth 首选 | **Temporal**（自托管） | MIT [已核验] | 最成熟的持久化执行引擎，多语言 SDK | **Hatchet**（MIT [已核验]，基于 Postgres，更轻）；DBOS（MIT [已核验]，库形态，无独立服务） | Temporal 需要独立集群（数据库 + 可选 Elasticsearch），运维较重；Temporal Cloud 在中国大陆不可用 [假设] | ①批量/SKU 单批 > 1,000 子任务，需要扇出与汇聚；②有跨小时或跨天的人工审批等待；③补偿逻辑超出 3 层；④自研状态机的缺陷率持续偏高 |
| 不选 | Restate | **BSL 1.1**（禁止作为公共 Restate 平台服务，自用允许）[已核验] | 许可非 OSI | — | — | — |
| 不选 | Inngest | **SSPL v1**（未来转 Apache-2.0）[已核验] | 许可非 OSI | — | — | — |

## F.4 对象存储、媒体分发与图像变换

| 项 | MVP 选择 | 许可 | 说明 | 备选 | 触发 |
|---|---|---|---|---|---|
| 对象存储 | **阿里云 OSS 或火山引擎 TOS**（S3 兼容 API） | Managed | 私有桶 + 版本控制 + 生命周期规则（`uploads/` 1 天，`tmp/` 7 天，未引用的生成变体 30 天）；代码只依赖 S3 兼容接口（AWS SDK v3，Apache-2.0） | 自托管 **SeaweedFS**（Apache-2.0 [已核验]） | 私有化部署或成本驱动时用自托管 |
| 不选 | MinIO 社区版 | AGPL-3.0；**官方仓库 README 声明“不再维护”**，转向 AIStor 免费或企业版 [已核验] | 维护状态不可接受 | Garage（AGPL [未核验：本次无法访问其仓库]） | — |
| 本地开发 | SeaweedFS（docker compose，S3 网关） | Apache-2.0 | 与生产 S3 API 兼容 | LocalStack | — |
| CDN | 云厂商 CDN（需 ICP 备案域名） | Managed | 缩略图、字体分片、前端静态资源；签名 URL 或签名 Cookie 防盗链 | — | — |
| 图像变换 | **在 ingest 时生成固定渲染副本**（sharp/libvips） | sharp：Apache-2.0；libvips：LGPL-2.1 [已核验] | 固定尺寸（256/1024/2048）覆盖 MVP 所有场景；无运行时依赖；可移植 | 云 OSS 图片处理（Managed，便捷但锁定）；**imgproxy**（Apache-2.0 [已核验]，Pro 版为商业）、Thumbor（MIT [已核验]） | 需要任意尺寸、裁剪或格式的动态变换时，引入 imgproxy |

## F.5 全文与向量搜索（只在需要时）

| 阶段 | 选择 | 许可 | 说明 | 触发 |
|---|---|---|---|---|
| MVP | PostgreSQL `ILIKE` + `pg_trgm`（项目名、素材名、标签） | OSI | 数据量小（每用户数百到数千条） | — |
| Phase 2 | PG 全文检索 + 中文分词 **zhparser**（PostgreSQL 风格许可 [已核验]）或 pg_jieba | OSI | 模板库与技能检索需要中文分词 | 模板数 > 500，或用户反馈搜索质量差 |
| Phase 3 | **pgvector**（PostgreSQL 风格许可 [已核验]）存图像和文本嵌入 | OSI | “找相似素材 / 相似模板” | 素材库按相似度检索成为功能需求 |
| Growth | OpenSearch（Apache-2.0 [已核验]） | OSI | 需要大规模、多字段、聚合检索时 | 搜索 QPS 或数据量压垮主库 |
| 注意 | Meilisearch | MIT + **BUSL-1.1（EE 部分）** [已核验] | 只用 MIT 部分时需避开 EE 特性 | — |
| 注意 | Elasticsearch | 非宽松许可（AGPL / SSPL / ELv2 多选，**本次未核验**） | 优先 OpenSearch | — |

## F.6 身份认证与授权

| 项 | MVP 选择 | 许可 | 为什么 | 备选 | 运维 | 触发 |
|---|---|---|---|---|---|---|
| 认证 | **Better Auth**（嵌入 API 进程的库，npm 1.7.x） | MIT [已核验] | 不需要额外服务；支持邮箱、OAuth 与插件（手机号 OTP 插件以官方文档为准）；数据在自己的 Postgres | **Casdoor**（Apache-2.0 [已核验]，对国内登录方式支持较全）；**Logto**（MPL-2.0 [已核验]）；**Keycloak**（Apache-2.0 [已核验]，重）；Ory Kratos（Apache-2.0 [已核验]） | 短信网关为 Managed（阿里云短信等） | 企业 SSO（SAML/OIDC）、团队目录同步，或多个产品共享身份时，迁移到 Casdoor、Logto 或 Keycloak |
| 不选 | Zitadel | **AGPL-3.0** [已核验] | 可用，但对小团队而言 AGPL 带来额外合规负担 | — | — | — |
| 授权 | **应用内策略模块 `authz` + PostgreSQL RLS** | — | MVP 只有“所有者”和“工作空间成员”两类关系 | **OpenFGA**（Apache-2.0 [已核验]）；SpiceDB（Apache-2.0 [已核验]） | — | 引入分享链接、团队、文件夹继承权限等关系型授权时（Phase 4） |

## F.7 可观测性、日志、追踪、指标与 AI 评测

| 项 | MVP 选择 | 许可 | 说明 | 备选 | 触发 |
|---|---|---|---|---|---|
| 埋点标准 | **OpenTelemetry**（JS SDK + Collector） | Apache-2.0（通识） | 后端可自由更换 | — | — |
| 日志、指标、Trace 后端 | **云托管**（阿里云 SLS + ARMS，或火山引擎同类产品） | Managed | 小团队不自运维；数据留在境内 | 自托管：Prometheus（Apache-2.0）或 **VictoriaMetrics**（Apache-2.0 [已核验]）+ Grafana / Loki / Tempo（**AGPL-3.0** [已核验 Grafana]）；或 **SigNoz**（核心 MIT + `ee/` 商业 [已核验]） | 成本或私有化需要 |
| 前端错误 | 托管 RUM 或自托管 | — | **Sentry 自托管为 FSL-1.1（source-available，两年后转 Apache-2.0）** [已核验] | GlitchTip（许可本次未核验） | — |
| AI 追踪 | **MVP：自有表**（`ai_turns`、`ai_tool_calls`、`model_calls`）+ OTel span | — | 自托管 Langfuse v3 依赖 ClickHouse、Redis、S3 等多个组件，对 MVP 偏重 | **Langfuse**（核心 MIT，`ee/` 目录另行许可 [已核验]） | 评测与标注工作流变复杂、需要提示词版本管理 UI 时引入 Langfuse |
| AI 评测 | `evals/` 目录下的基准任务集，CI 每夜运行，结果写表并出看板 | — | 见 Part 9 §I.3 | promptfoo（许可本次未核验） | — |

## F.8 图像处理、导出、视频与字体服务

| 项 | MVP 选择 | 许可 | 说明 | 备选 | 触发 |
|---|---|---|---|---|---|
| 图像处理 | **sharp**（libvips 绑定） | Apache-2.0 / libvips LGPL-2.1 [已核验] | 低内存、快速；在 Node Worker 中运行 | Pillow（Python） | 需要 ML 模型时用 Python `ml-worker` |
| 位图与 PDF 导出 | **Playwright + Chromium**（`apps/renderer`） | Playwright：Apache-2.0 [已核验]；Chromium：BSD 类（通识） | 与编辑器共用 `doc-render`，一致性有保证；`page.pdf()` 产出矢量 PDF | Fabric/Konva + node-canvas（作为 M0 对照）；IMG.LY CE.SDK Renderer（Commercial） | 渲染队列等待 p95 > 30s 时扩容；需要印刷 CMYK 时评估专用 PDF 库 |
| 视频合成（Phase 3） | **FFmpeg**（filtergraph 由 storyboard 编译而来）+ `doc-render` 渲染字幕卡 | LGPL-2.1+ 或 GPL（取决于编译选项，通识；**须选用 LGPL 构建，并评估 H.264/AAC 专利**） | 稳定、成本低 | **Remotion**（source-available 自定义许可：个人和不超过 3 名员工的营利组织免费，其余需公司许可 [已核验]）；IMG.LY CE.SDK（Commercial） | 需要 React 动态模板动画时引入 Remotion |
| 字体文件 | 思源黑体、宋体（OFL-1.1 [已核验]）、霞鹜文楷（OFL-1.1 [已核验]） | OFL | 可商用、可嵌入；按 `unicode-range` 分片 | 商业字库需单独授权（覆盖 Web 嵌入和服务端渲染） | 品牌方提出字体需求时 |
| 字体分片工具 | **fonttools**（`pyftsubset`，构建期使用）或 HarfBuzz `hb-subset` | MIT [已核验] / Old MIT [已核验] | 构建期生成，运行期不需要 Python | cn-font-split（许可本次未核验） | — |
| 字体分发 | CDN + `@font-face`（同一份 CSS 供浏览器与 Renderer 使用） | — | — | — | — |

## F.9 CI/CD、密钥、部署、备份与容灾

| 项 | MVP 选择 | 许可 | 说明 | 备选 | 触发 |
|---|---|---|---|---|---|
| 代码托管与 CI | **GitHub Actions**（当前仓库在 GitHub） | Managed | 构建、测试、镜像推送 | 云效（阿里云）、Gitea Actions（自托管） | 网络或合规要求代码与制品在境内时 |
| 镜像仓库 | 云厂商容器镜像服务（境内） | Managed | 减少跨境拉取 | Harbor（Apache-2.0，通识） | — |
| 部署（MVP） | **2–3 台 ECS + Docker Compose**，滚动发布脚本；或 Serverless 应用引擎 | Managed | 最低运维；适合小团队 | 托管 K8s（ACK） | 服务数 > 5、需要自动伸缩，或团队有专职 SRE 时迁到 K8s |
| 部署（Growth） | 托管 K8s + Helm + **Argo CD** | Argo CD：Apache-2.0 [已核验] | GitOps | Flux | — |
| 密钥 | **云 KMS 与凭据管理服务** | Managed | 供应商密钥只注入 Worker 和 API | **OpenBao**（MPL-2.0 [已核验]）；**SOPS**（MPL-2.0 [已核验]）加密配置；Infisical（核心 MIT，`ee/` 另行许可 [已核验]） | 私有化部署时用 OpenBao |
| 不选 | HashiCorp Vault（新版本） | **BSL 1.1**（4 年后转 MPL-2.0）[已核验] | 非 OSI；选 OpenBao | — | — |
| 数据库备份 | 托管 RDS 自动备份 + **PITR（7–30 天）**；每周逻辑备份导出到另一个区域的 OSS | Managed | — | 自托管：CloudNativePG（Apache-2.0 [已核验]）+ pgBackRest（MIT [已核验]） | — |
| 对象存储容灾 | 版本控制 + 跨区域复制（Growth） | Managed | MVP 只开版本控制 | — | 有付费用户或 SLA 承诺时开启跨区域复制 |
| 恢复目标（提议） | RPO ≤ 5 分钟（PITR），RTO ≤ 4 小时（MVP） | — | 每季度演练一次恢复 | — | — |

## F.10 前端与 AI 相关组件许可汇总

| 组件 | 用途 | 许可 | 类别 |
|---|---|---|---|
| tldraw / @tldraw/editor / @tldraw/sync 5.6.0 | Board 首选 | **tldraw license**（生产需许可证密钥）[已核验] | SA |
| @tldraw/tlschema 5.6.0 | — | MIT [已核验] | OSI |
| Excalidraw、Konva、Fabric.js、Leafer UI、PixiJS、xyflow | 备选或参考 | MIT [已核验] | OSI |
| Moveable、Selecto、rbush | 编辑器与保底 Board | MIT [已核验] | OSI |
| Yjs、Hocuspocus | Phase 4 协作 | MIT [已核验] | OSI |
| fractional-indexing | 排序键 | CC0 [已核验] | 公共领域 |
| React、TanStack Router/Query、Zustand、Radix、Zod | 前端基础 | MIT [已核验，React 为通识] | OSI |
| OpenAI Agents SDK（JS） | 可选的 Agent 辅助库 | MIT [已核验] | OSI |
| Vercel AI SDK | 可选的供应商抽象 | Apache-2.0 [已核验] | OSI |
| Qwen-Image（代码） | 自托管图像模型候选 | Apache-2.0 [已核验：GitHub 仓库 LICENSE；**权重许可需在模型卡单独确认**] | OSI（代码） |
| SAM 2 | 交互式分割 | Apache-2.0 [已核验] | OSI |
| BiRefNet | 抠图 | MIT [已核验] | OSI |
| RMBG-2.0 | 抠图 | **CC BY-NC 4.0，商用需与 BRIA 签协议** [已核验] | 非商用 |
| PaddleOCR | OCR | Apache-2.0 [已核验] | OSI |
| Real-ESRGAN | 超分 | BSD-3-Clause [已核验] | OSI |
| ComfyUI | 自托管工作流（可选） | **GPL-3.0** [已核验]；以网络服务形式使用不触发分发义务，修改后分发则需开源 | OSI（copyleft） |
| 外部模型 API（豆包、千问、Seedream、Seedance 等） | 生成 | 服务条款 + 备案 | Model API |

## F.11 组件引入时间线

```text
MVP：      PostgreSQL · 对象存储 + CDN · KMS · 托管日志与指标 · pg-boss · Chromium Renderer · sharp
Phase 2：  + zhparser 中文检索 · + imgproxy（如需要）· + 微信登录
Phase 3：  + FFmpeg 视频 Worker · + pgvector · + Python ml-worker（如需自托管）
Phase 4：  + Valkey · + 协作服务（tldraw sync 或 Yjs/Hocuspocus）· + OpenFGA · + 工作流引擎（如达到触发条件）· + K8s
```

## F.12 全球化上线时的变化（相对于 China-first）

| 维度 | China-first（临时方案） | Global |
|---|---|---|
| 云 | 阿里云或火山引擎，单区域 | AWS、GCP 或 Azure；按法域分区部署（EU、US），**数据不跨区复制** |
| LLM | 豆包、通义千问、DeepSeek | OpenAI、Anthropic、Google；国内模型仅在其国际版（如 BytePlus）可合规使用时考虑 |
| 图像/视频 | Seedream、Seedance（火山方舟）、Qwen-Image、万相 | GPT Image 2.5（OpenAI [二手：见 architecture-review]）、BytePlus Seedream/Seedance 国际版等。Sora Videos API 已于 2026-09-24 关停 [二手] |
| 审核 | 国内内容安全服务 | 供应商审核 + 自有分类器 |
| 合规 | 生成式 AI 登记或备案、显式与隐式标识（GB 45438-2025）、ICP 备案、个人信息保护法（PIPL）、模型名称与备案号公示 | GDPR、EU AI Act 第 50 条透明度义务 [待定：适用范围与时间]、C2PA Content Credentials、各州隐私法 |
| 登录 | 手机号 OTP、微信 | 邮箱、Google、Apple |
| CDN | 需 ICP 备案 | Cloudflare 或云 CDN |
| tldraw sync（Phase 4） | 自托管 Node 模板 | 可选 Cloudflare Durable Objects 模板 |
| 支付（如需） | 不在范围 | 不在范围 |

架构本身不变，变化都在**配置、适配器和部署单元**层面，这正是 AD-11 和适配器设计要达到的效果。
