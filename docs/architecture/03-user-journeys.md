# Part 3 · 用户旅程与时序图（交付物 C）

每条流程都列出：**真相源（System of Record, SoR）**、API 调用与事件、任务状态迁移、幂等策略、授权检查和用户可见反馈。端点和事件的完整契约见 Part 7。

通用约定：

- 所有写请求带 `Idempotency-Key` 头（客户端 UUIDv7），服务端在 `idempotency_keys` 表保存 24 小时。
- 授权检查记作 `authz(action, resource)`。资源不存在和无权限都返回 `404`，避免泄露资源是否存在。
- 事件通过 SSE `GET /v1/projects/{id}/events` 推送，信封格式见 Part 7 §G.6。

---

## C.1 创建项目并打开 AI 无限画布工作区

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web
  participant A as API
  participant DB as PostgreSQL
  U->>W: 首页点击“开始创作”或提交需求
  W->>A: POST /v1/projects {title?, initial_prompt?} + Idempotency-Key
  A->>A: authz(project.create, workspace)
  A->>DB: BEGIN 写 projects、documents(board v1 空)、ai_sessions 和 outbox，然后 COMMIT
  A-->>W: 201 {project_id, board_document_id, session_id}
  W->>W: 路由到 /p/{project_id}
  W->>A: GET /v1/projects/{id}/workspace
  A->>A: authz(project.read)
  A->>DB: 读 board 快照 + 之后的 ops、artboard 摘要、会话、活跃任务、事件游标
  A-->>W: 200 workspace bootstrap
  W->>A: GET /v1/projects/{id}/events（SSE，Last-Event-ID = 游标）
  W->>W: BoardEngine.load(boardDoc)，渲染空 Board 和对话欢迎语
  opt 首页带了需求
    W->>A: POST /v1/ai/sessions/{sid}/turns（见 C.2）
  end
```

| 项目 | 内容 |
|---|---|
| SoR | `projects`、`documents`（kind=board）、`ai_sessions` |
| 幂等 | `Idempotency-Key` 重放时返回同一个 `project_id`，避免双击建出两个项目 |
| 授权 | workspace 成员才能建项目；读 bootstrap 需要项目读权限 |
| 用户反馈 | 骨架屏 → 欢迎语与技能面板（沿用原型 `st-greeting`）；SSE 断线时顶部显示“正在重连”提示 |
| 与原型差异 | 原型“新建创作”会替换唯一的本地会话；新方案每个项目都有独立会话，可以有多个会话 |

---

## C.2 上传商品图 → 选择技能 → 提交 → 在 Board 上生成多个可编辑方案

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web
  participant A as API
  participant OS as 对象存储
  participant Q as jobs + pg-boss
  participant WK as Worker
  participant P as 图像/LLM 供应商
  participant R as Renderer
  U->>W: 拖入商品图
  W->>A: POST /v1/assets/uploads {filename, mime, bytes, sha256}
  A->>A: authz(asset.create), 校验类型和大小, 配额
  A-->>W: {asset_id, upload_url, headers, expires_at}
  W->>OS: PUT uploads/{asset_id}（预签名）
  W->>A: POST /v1/assets/{id}/complete
  A->>Q: job media.ingest (idempotency = asset_id)
  WK->>OS: 读取 → 解码校验 → 重编码 → 渲染副本
  WK->>WK: 输入审核
  WK-->>A: outbox asset.ready
  A-->>W: SSE asset.ready（缩略图）
  U->>W: 选择技能“商品套图”，填写卖点，回车
  W->>A: POST /v1/ai/sessions/{sid}/turns {text, skill_id, attachments:[asset_id], mode, ratio, count}
  A->>A: authz, 配额预估与预留, 文本输入审核
  A->>Q: ai_turns(status=queued) + job ai.turn
  A-->>W: 202 {turn_id}
  WK->>WK: AgentLoop 识别技能有对应配方 → recipes.run(product_hero_set@1)
  WK->>P: LLM：卖点提炼、文案、版式选择（结构化输出）
  WK->>Q: N 个 gen.image 任务（背景/场景图，每个都有 idempotency key）
  A-->>W: SSE ai.turn.updated(step: 生成场景图 0/N)
  par 每个变体
    WK->>P: 图像生成
    P-->>WK: 图片 URL 或 base64
    WK->>OS: media.ingest：转存、审核、隐式标识
  end
  WK->>WK: 组装 Artboard：模板 + 商品抠图 + 生成背景 + 真实文字层
  WK->>A: documents.createArtboards + board.place_items（result_group）
  A-->>W: SSE document.committed(board), artboard.created × N
  WK->>Q: render.thumbnail × N
  R-->>A: SSE asset.ready（缩略图）
  WK-->>A: ai_turns completed, 结算配额
  A-->>W: SSE ai.turn.updated(completed), ai.message.completed
  W->>W: Board 视口自动适配新方案组，选中第一个
```

| 项目 | 内容 |
|---|---|
| SoR | `assets`（素材与生成图）、`documents`（Artboard 和 Board 条目）、`ai_turns`、`ai_tool_calls`、`jobs`、`usage_ledger` |
| 任务状态 | `media.ingest`：queued → running → succeeded / blocked；`gen.image`：queued → dispatching → running → ingesting → moderating → succeeded / failed / blocked；`ai_turns`：queued → running → awaiting_jobs → running → completed |
| 幂等 | 上传以 `asset_id` 为键；回合以 `Idempotency-Key` 为键；`gen.image` 以 `{turn_id}:{step}:{variant}` 为键；文档写入以 `client_op_id` 为键 |
| 授权 | 附件必须属于同一 workspace 且可读；Agent 工具只能作用于 `session.project_id` |
| 用户反馈 | 对话中的步骤进度条（沿用原型三阶段，改为**真实**步骤）；Board 上先出现占位卡片（“生成中 2/4”），完成后替换；部分失败时卡片显示“重试这一张” |
| 可编辑性保证 | 文字、Logo、价格标签等都是真实 text/image 节点；模型只生成**像素区域**（背景、场景）。商品主体默认用**抠图后合成**，以保证保真 [假设：M0 验证] |

---

## C.3 选中方案 → 对话修改 → 原稿与新版本并存

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web
  participant A as API
  participant WK as Worker
  participant P as 供应商
  U->>W: 选中方案 ab_2，点“继续修改”，输入“换成暖色，标题改为‘秋日上新’”
  W->>A: POST /turns {text, reference:{artboard_id: ab_2, revision: 14}}
  A->>A: authz(artboard.read ab_2)
  A-->>W: 202 {turn_id}
  WK->>WK: ContextBuilder：artboard.describe(ab_2@14) + 预览图
  WK->>WK: LLM 规划：只改配色 token 和 headline 文本，无需生成新图
  WK->>A: artboard.create_version(source=ab_2@14) → 新文档 ab_7（复制 + ops）
  A->>A: documents：ab_7.parent=ab_2，在 Board 上紧邻原稿放置，lineage(ai_revision, turn_id)
  A-->>W: SSE artboard.created(ab_7), document.committed(board)
  opt 修改涉及换背景
    WK->>P: images.edit 或 generate（只针对背景 slot）
    WK->>A: artboard.propose_ops 或直接写入 ab_7（ab_7 是新文档，无冲突）
  end
  WK-->>A: turn completed
  A-->>W: SSE ai.message.completed “已保留原方案，生成 V2”
  W->>W: Board 上 ab_2 与 ab_7 并列，显示 V1 → V2 连线
```

| 项目 | 内容 |
|---|---|
| SoR | 原稿 `ab_2` **不变**；新版本 `ab_7` 是新文档，`parent_document_id = ab_2`，`created_from = {kind: ai_revision, turn_id, base_revision: 14}` |
| 默认语义 | **新版本**（AD-10）。用户如需“就地修改当前稿”，在输入框切换“修改当前稿”，AI 改为生成 Proposal（见 C.8） |
| 幂等 | 回合幂等键；`create_version` 以 `{turn_id}:{source_id}` 去重 |
| 授权 | 对 `ab_2` 需有读权限，在项目内写 Board 需有写权限 |
| 用户反馈 | 新卡片带“V2 · 来自 V1”徽标；对话显示“改了什么”的结构化摘要，如“配色：温暖奶油；主标题：秋日上新” |
| 与原型对应 | 原型的 `resolveStudioBrief(previous, revision)` 与 `version` 逻辑升级为真实的文档谱系 |

---

## C.4 打开 Artboard 精细编辑 → 保存 → 回到 Board → 导出

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web
  participant A as API
  participant Q as jobs
  participant R as Renderer
  participant OS as 对象存储
  U->>W: 双击 Board 上的 ab_7
  W->>A: GET /v1/documents/ab_7（如本地缓存修订号已是最新，则跳过）
  W->>W: 进入聚焦模式：ArtboardEditor 挂载（doc-render + 变换控件）
  U->>W: 改标题（中文输入法）、拖动商品、改字号
  W->>W: 本地乐观应用 ops，输入法 compositionend 后合并，按 500ms 空闲或指针抬起批量提交
  W->>A: POST /v1/documents/ab_7/ops {base_revision: 3, client_op_id, ops[]}（If-Match）
  A->>A: authz(document.write), schema 校验, 应用, revision=4
  A-->>W: 200 {revision: 4}；SSE document.committed（发给其他标签页）
  U->>W: Ctrl+S 或点“保存版本”
  W->>A: POST /v1/documents/ab_7/versions {label: "终稿"}
  U->>W: 返回 Board
  W->>W: 卸载编辑器；Board 上 ab_7 显示本地即时渲染，同时等待新缩略图
  A->>Q: render.thumbnail(ab_7@4)（防抖，最多每 10s 一次）
  U->>W: 导出 PNG 2x
  W->>A: POST /v1/exports {document_id: ab_7, revision: 4, format: png, scale: 2}
  A->>Q: job render.export (idempotency = doc@rev+options 哈希)
  R->>R: Chromium 打开 /render?doc=ab_7&rev=4（内部路由），加载字体，等待 fonts.ready，截图
  R->>R: 写入隐式 AI 标识元数据（如含 AI 生成内容）
  R->>OS: exports/{export_id}.png
  A-->>W: SSE export.completed {download_url（预签名，10 分钟）}
```

| 项目 | 内容 |
|---|---|
| SoR | `document_ops` 加 `document_snapshots`；导出产物为 `exports` 加 `assets(kind=export)` |
| 自动保存 | 没有“未保存”概念：每个提交批次都持久化。“保存版本”只是给某个修订号打命名标签。断网时 ops 进入 IndexedDB 队列，恢复后续传（Part 4 §D.5） |
| 幂等 | `client_op_id` 唯一；同一 `doc@rev + 导出参数` 的导出在 24h 内复用已有产物 |
| 授权 | 写 ops 需有 `document.write`；导出需有 `document.read`；下载 URL 绑定导出的所有者 |
| 一致性保证 | 导出用的渲染器与编辑器是同一个 `doc-render`，字体文件也是同一份（Part 4 §D.6） |
| 用户反馈 | 标题栏显示“已同步 / 同步中 / 离线（N 项待同步）”；导出显示进度，完成后自动下载 |

---

## C.5 离开并重新打开项目：恢复对话、画布、素材与任务

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web
  participant IDB as IndexedDB
  participant A as API
  U->>W: 关闭标签页（此时有 1 个生成任务在运行，有 2 个本地 ops 未提交）
  Note over W,IDB: 关闭前 ops 已写入 IndexedDB 队列（每次本地应用都同步写入）
  Note over A: 任务在 Worker 中继续运行，与浏览器无关
  U->>W: 次日重新打开 /p/{id}
  W->>IDB: 读取缓存的文档、待提交 ops 和上次的事件游标
  W->>A: GET /v1/projects/{id}/workspace?since_event={cursor}
  A-->>W: board 与 artboard 的修订号、会话最近 50 条消息、活跃任务 + 终态任务摘要、新游标
  W->>A: 重放待提交 ops（base_revision 为当时的值）
  alt 无冲突
    A-->>W: 200 新 revision
  else 同一属性在服务端已被修改
    A-->>W: 409 DOC_REVISION_CONFLICT {conflicts}
    W->>W: 拉取最新版本，提示“你离线时的 2 处修改与新版本冲突”，提供保留我的 / 使用最新
  end
  W->>A: SSE 订阅（Last-Event-ID = 新游标）
  W->>W: 恢复视口（存在 board_views，按用户维度）、对话滚动位置、进行中任务的进度卡
```

| 项目 | 内容 |
|---|---|
| SoR | 全部在服务端：对话 `ai_messages`、Board 和 Artboard `documents`、素材 `assets`、任务 `jobs`。IndexedDB 只是缓存和未提交 ops 的暂存 |
| 恢复内容 | 对话（分页加载）、Board（快照 + ops）、视口（`board_views` 表，按用户和 Board）、选中状态（不持久化）、运行中任务（状态与进度来自 `jobs`）、Agent 回合（终态或 `awaiting_jobs`） |
| 幂等 | 重放的 ops 用原 `client_op_id`；如果服务端已应用过，返回原结果而不是重复应用 |
| 用户反馈 | “已恢复：3 个方案在你离开期间生成完成”的提示条；冲突时用明确的对比视图 |
| 与原型差异 | 原型把运行中的生成标为“已暂停”，因为计时器在浏览器里；真实任务在服务端继续运行 |

---

## C.6 长时视频 / 分镜任务与事件驱动续跑（Phase 3，先定契约）

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web
  participant A as API
  participant WK as Worker
  participant V as 视频供应商
  participant R as Renderer
  U->>W: “用这 3 张图做 15 秒广告”
  W->>A: POST /turns {text, attachments:[3 张], mode: video}
  A-->>W: 202 {turn_id}
  WK->>WK: AgentLoop：创建 storyboard 文档（3 个 shot）
  WK->>A: documents.create(kind=storyboard)
  WK->>A: jobs.create gen.video × 3 (idempotency {turn}:{shot})
  WK->>WK: 调用 jobs.await([j1,j2,j3]) → 回合状态改为 awaiting_jobs，Worker 释放
  A-->>W: SSE ai.turn.updated(awaiting_jobs), “分镜已生成，3 个片段排队中”
  loop 每个片段
    WK->>V: 提交任务（task_id 存入 jobs.provider_job_id）
    WK->>WK: gen.poll 延迟重试（30s、60s、120s……上限 5 分钟，总截止 30 分钟）
    V-->>WK: succeeded + 临时 URL
    WK->>WK: media.ingest：立即下载、ffprobe 校验、审核、标识
    A-->>W: SSE job.updated(succeeded), asset.ready
  end
  A->>A: jobs 模块检测到 turn 等待的任务全部进入终态
  A->>WK: 入队 ai.turn(continuation, turn_id)
  WK->>WK: ContextBuilder 从数据库重建上下文 + 任务结果
  WK->>A: storyboard.apply_ops（放入片段、字幕）
  WK->>A: jobs.create render.video(storyboard@rev)
  WK-->>A: turn completed
  R->>R: FFmpeg 合成，字幕卡由 doc-render 渲染
  A-->>W: SSE export.completed
```

| 项目 | 内容 |
|---|---|
| SoR | `documents(kind=storyboard)`、`jobs`、`assets(kind=video_clip)`、`ai_turns.waiting_on_job_ids` |
| 关键设计 | **没有任何进程在等待期间持有状态**；续跑回合可在任意 Worker 执行；用户关闭浏览器不影响任务 |
| 幂等 | 每个 shot 一个幂等键；续跑以 `turn_id + continuation_seq` 去重，防止多个任务同时完成时重复触发 |
| 用户反馈 | 分镜卡片逐个变成可播放的片段；任务中心显示“排队 / 生成中 / 已完成 2/3” |

---

## C.7 失败路径

### C.7.1 汇总表

| 场景 | 检测 | 任务状态迁移 | 系统行为 | 用户可见反馈 |
|---|---|---|---|---|
| 供应商超时 | 同步调用超过 `timeout_ms`；异步任务超过 `deadline_at` | running → **waiting_retry** → running（退避）→ 超过次数上限则 **failed**(`PROVIDER_TIMEOUT`) | 指数退避（基数 2s，上限 60s，最多 3 次），带抖动；不自动换供应商（AD-11） | “这一张生成超时，可重试”；回合仍会完成其他变体 |
| 部分成功 | N 个变体中有 k 个成功 | 父级 `recipe_run` → **partially_succeeded** | 成功的变体正常落到 Board；失败的保留占位卡和原参数 | 方案组标题显示“3/4 完成”，失败卡显示“重试这一张”（只重试这一张） |
| 用户取消 | `POST /v1/ai/turns/{id}/cancel` 或 `/jobs/{id}/cancel` | turn → **cancelled**；子任务：queued 直接 **cancelled**；running 先置 `cancel_requested`，若供应商支持取消就取消，否则等结果返回后丢弃并 **cancelled** | 已产生的成本照实记账；已完成的产物按用户选择保留或丢弃（默认保留） | 对话显示“已停止，已完成的 2 张保留在画布上” |
| 用户重试 | `POST /v1/jobs/{id}/retry` | 创建**新任务**，`retry_of = 原任务`（原任务终态不变） | 复用原输入快照；用户可修改参数后重试 | 新占位卡替换失败卡 |
| 审核拒绝（输入） | 提交前文本/图片审核 | 回合 → **failed**(`MODERATION_INPUT_REJECTED`)，不调用模型 | 不消耗生成配额；在 `moderation_events` 留痕 | “提示词包含不支持生成的内容”（不暴露具体规则） |
| 审核拒绝（输出） | `media.ingest` 审核阶段 | 任务 → **blocked** | 产物进入隔离区，不对用户可见，按保留策略删除 | 占位卡显示“该结果未通过内容安全检查”，提供“换个说法重试” |
| 配额超限 | 提交时预估 + 预留；执行中实际扣减超出 | 提交被拒，返回 `429 QUOTA_EXCEEDED`；执行中超出则回合 → **failed**(`BUDGET_EXHAUSTED`) 并保留已完成部分 | 预留未用完的部分会返还 | 显示剩余额度和重置时间 |
| 输出 URL 过期 | ingest 下载返回 403/404 | ingesting → waiting_retry；若供应商支持按 task_id 重新取 URL 则重取；否则 **failed**(`OUTPUT_EXPIRED`) | 正常情况下拿到 URL 就立即 ingest，过期只出现在 Worker 长时间宕机后；对账任务会补偿 | “结果已过期，可免费重新生成”（不扣配额） |
| Worker 崩溃 | pg-boss 心跳或过期 | 投递层重新投递；业务状态由处理器按阶段幂等续做 | 对账任务每 5 分钟扫描卡住的任务（`updated_at` 超过阈值），重新查询供应商状态 | 无感知或仅有延迟 |

### C.7.2 时序：部分成功 + 重试 + 审核拦截

```mermaid
sequenceDiagram
  autonumber
  participant WK as Worker
  participant P as 图像供应商
  participant M as 内容安全
  participant A as API
  participant W as Web
  WK->>P: 变体 1–4 并发生成
  P-->>WK: v1 成功
  P-->>WK: v2 成功
  P--xWK: v3 超时
  P-->>WK: v4 成功
  WK->>M: 输出审核 v1、v2、v4
  M-->>WK: v1 通过, v2 通过, v4 拒绝
  WK->>A: jobs: v1、v2 succeeded；v3 waiting_retry；v4 blocked
  A-->>W: SSE job.updated × 4
  WK->>P: v3 重试（退避 2s）
  P--xWK: v3 再次超时（达到上限）
  WK->>A: v3 failed(PROVIDER_TIMEOUT)
  WK->>A: recipe_run partially_succeeded (2/4)
  A-->>W: SSE ai.message.completed “2 个方案已完成，1 个超时可重试，1 个未通过安全检查”
  W->>A: 用户点 v3 “重试这一张” → POST /v1/jobs/{v3}/retry
  A-->>W: 202 {job_id: v3b}
```

---

## C.8 用户编辑时 AI 正在准备修改（并发）

场景：用户让 AI“把所有标题改得更醒目”，同时自己在编辑 `ab_7` 的副标题和商品位置。

```mermaid
sequenceDiagram
  autonumber
  actor U as 用户
  participant W as Web（编辑器打开 ab_7）
  participant A as API
  participant WK as Worker
  U->>W: 对话：“把标题改得更醒目”（选择“修改当前稿”）
  W->>A: POST /turns {reference: ab_7@4, apply_mode: proposal}
  WK->>WK: 读取 ab_7@4，规划 ops：headline.size 72→96, headline.weight 700→900
  U->>W: 同时修改副标题文字、拖动商品
  W->>A: POST ops (base 4) → revision 5、6
  WK->>A: artboard.propose_ops {document: ab_7, base_revision: 4, ops}
  A->>A: proposals 表写入 pending；检查与 rev 5、6 的冲突（按节点 id + 属性路径）：无重叠
  A-->>W: SSE proposal.created {proposal_id, summary, touched_paths}
  W->>W: 编辑器顶部显示提议条和差异预览（高亮受影响图层）
  U->>W: 点“应用”
  W->>A: POST /v1/proposals/{id}/apply
  A->>A: rebase 到 rev 6（路径不重叠，直接应用）→ revision 7，origin = ai:turn_x
  A-->>W: 200 + SSE document.committed(rev 7)
  Note over U,A: 如果用户同时也改了 headline.size：apply 返回 409，提议标记为 stale，<br/>AI 可基于新版本重新生成提议，或由用户手动选择
```

| 项目 | 内容 |
|---|---|
| SoR | 文档 `document_ops`；提议 `proposals`（pending / applied / rejected / stale） |
| 冲突判定 | 以 `(node_id, property_path)` 为粒度。插入/删除节点与对该节点的属性修改视为冲突；同一父节点下的不同节点插入不冲突（用分数索引） |
| 撤销 | 应用后的提议是**一个事务**，可以“撤销 AI 修改”（服务端用 `document_ops.inverse` 反向应用）；用户自己的本地撤销栈不包含 AI 修改（AI 修改通过远端事件到达，不进入本地 history） |
| 授权 | 应用提议需要 `document.write`；提议创建者（AI 回合）必须属于同一项目会话 |
| 用户反馈 | 提议条显示“AI 建议修改 2 处：标题字号、字重”，可预览、应用、拒绝；stale 时显示“文档已变化，重新生成建议” |
