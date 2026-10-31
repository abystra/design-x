# Agent 创作：当前实现与验收

2026-10-31。此实现复用现有高仿真工作室、Board、精细编辑器与导出链路。tldraw 的独立提交和性能记录见 [Board 验收](tldraw-board.md)，供应商连通性与同 thread 两轮实测见 [运行时验证](ai-runtime.md)。

## 实际执行路径

```text
Studio 输入/授权素材 → POST ai-turns（幂等键、项目权限、冻结上下文）
 → PostgreSQL jobs + ai_turns + pg-boss
 → Worker（执行 token / deadline / ai_attempts）
 → E2B 官方 SDK 创建指定 Codex 模板
 → 沙箱内 Harness → @openai/codex-sdk → Codex CLI → DeepSeek Responses
 → 真实工具写 artifact.json / 校验 → Worker 读取 manifest
 → schema / 图片引用 / 版本 / 执行 fence 校验
 → 创建 Artboard + Board 追加，或存储修改提案
 → outbox / SSE + 回合查询 → 工作室显示真实状态与作品
 → 现有 Editor 手工修改 → 统一 Renderer PNG/PDF 导出
```

当前使用 `e2b@2.62.0`、`@openai/codex-sdk@0.166.0`、模板 `u1yrkaokyjzef8qchho5`，模板预装 Codex CLI `0.164.0`、Node `20.9.0`。Worker 本地打包官方 SDK 和校验器后上传；沙箱不执行在线 npm 安装。默认 `deepseek-flash` 支持参考图片；并非将 Codex SDK 替换成普通模型 HTTP 调用。

## 产品行为与数据边界

- Agent 每轮 1–3 个可编辑方案，支持比例、中文需求、最多 3 张视觉参考；示例素材首次使用会走真实资产上传/摄取。生成的是文字、图片和几何图层，图片引用已有授权资产。图片模型和视频模型入口仍未开放。
- 回合状态、需求、引用、结果与提案存 PostgreSQL。刷新或离开再返回可读取，浏览器不保存模型密钥，也不靠计时器生成作品。失败和取消可显式重试；队列不自动重试收费 AI 回合。
- “继续修改”引用所选画板，生成完整候选且保持原文档不变。预览弹窗应用时检查捕获的 revision；期间手工修改造成 409，保留提案。成功应用保存不可变版本，不覆盖历史。
- 新画板合并采用“上次服务端确认、本地当前状态、远端最新状态”三方比较。保留等待期间的移动、便签和草稿；同字段冲突进入既有草稿下载/重载恢复流程。服务端新增画板加入所有旧撤销/重做检查点，撤销先前移动不能删除它们。
- Board 仍存轻量布局，Artboard 文档是真相源；没有把 tldraw snapshot 或 SDK thread 当作业务数据。AI 进度只刷新轻量回合列表，工具事件不触发所有设计的全量加载。
- 成功 POST 后立即接收权威响应，后续 GET 刷新失败独立提示，不把已成功写入误报失败而重复提交。失败的写请求保留幂等键，过期 GET 不能覆盖较新的 mutation 状态。

## 后端契约

| API | 行为 |
|---|---|
| `POST /api/projects/:id/ai-turns` | `Idempotency-Key` 必填；`prompt/count/ratio/mode/referenceDocumentIds/assetIds`；修改模式加 `targetDocumentId/baseRevision`；可带 `baseBoardRevision`；202 返回 Job 与 Turn |
| `GET /api/projects/:id/ai-turns` | 最近 50 回合的轻量状态，提案不含完整 design |
| `GET /api/ai-turns/:id` | 回合详情及完整修改提案 |
| `POST /api/ai-turns/:id/apply` | 幂等键 + `proposalId/baseRevision`；CAS 后返回更新 Artboard 与 Turn |
| `POST /api/jobs/:id/cancel`、`retry` | 沿用业务状态机；取消阻止迟到成果，重试生成新执行 token |

`db/migrations/0004_ai_turns.sql` 新增租户隔离的 `ai_turns`、`ai_attempts`。项目删除与 AI 提交按一致的锁顺序串行；取消、租约/执行编号变化、超时均不能落入成功提交。每次执行记录 sandbox/thread/model/usage/deadline/清理状态。创建响应丢失或 ID 迟到时，用 execution token 派生的 runKey 查找沙箱；截止时间前空查询不等于未创建，对账继续保留该记录。

## 凭证、运行限制与恢复

本地凭证仅在 Git 忽略且权限 0600 的 `.env.ai.local`；生产通过进程环境/秘密管理注入。`.env.example` 只提供变量名。没有将任何真实 key 放入前端、源码、测试报告或模型上下文。

E2B 私有入口，出站默认拒绝，仅放行 `api.deepseek.com`。E2B HTTPS 出站代理对该域注入真实模型 Authorization；沙箱内环境变量只含占位值。Harness 不持有 E2B 管理密钥、数据库或对象存储主凭证。Harness stdout 只发受控阶段、工具类型、thread 和 usage，不转发原始工具内容、stderr 或模型推理；错误输出做脱敏，Worker 不持久化任意 SDK 异常对象。

当前运行限制：默认沙箱 TTL 600 秒、SDK 回合 420 秒、命令 480 秒、最多 60 个工具事件；上下文及视觉参考有大小限制；artifact 必须是有限大小的常规 JSON 文件，读取结果以流计数并拒绝超过 2 MiB。外部回包即使符合 JSON，也必须通过文档、资源和业务校验才能提交。结束/取消执行 kill；对账处理清理失败及未记录 ID 的实例。

控制面持久化产品会话；每轮重新构造授权上下文，不提供跨沙箱 thread/文件检查点恢复承诺。当前未接入独立图片/视频模型、完整技能配方、自动视觉质量打分、多人实时协作、计费/配额账本及生产部署。资源上限和超时不是费用预算系统。tldraw 的生产使用仍须按其许可配置。

## 运行与复测

先启动基础设施、执行 `pnpm db:migrate`，在忽略配置中设置 `AI_ENABLED=true`、`E2B_API_KEY`、`DEEPSEEK_API_KEY`、`E2B_TEMPLATE_ID`、`DEEPSEEK_MODEL`。启动 `pnpm dev:all`；开发配置加载本地忽略文件，生产必须通过外部环境注入。`/api/health` 的 `aiEnabled` 仅表示入口开关，连通性须以真实验证证明。

```sh
pnpm verify:ai-runtime
python3 tests/e2e/ai_creation.py --allow-paid-ai
```

第一条真实执行同 thread 两轮工具与文件校验；第二条最多三次 UI 提交，覆盖参考图双方案、精修/PNG、修改预览/应用和立即取消，不自动重试付费回合。两者都会产生真实供应商使用量，普通单测不隐式执行。报告不保存凭证和浏览器网络 trace。

常规验证：`pnpm typecheck`、`pnpm check`、`pnpm build`、`pnpm test:unit`、`pnpm test:api`，以及现有 Board/Editor/Import/Render 浏览器回归。API 全量应在独立测试数据库运行，避免 Media 测试自启 Worker 消费开发环境待执行任务。

## 本轮实际证据

- 全量 API：55/55，含 AI 19 项；临时数据库及其专属 S3 对象均清理。覆盖授权/跨租户、幂等、创建/多候选修改、CAS、取消/迟到结果、沙箱 ID 丢失/迟到、失败与对账。API 测试注入运行适配器以测试故障，不作为真实模型成功证据。
- 非 AI 浏览器回归：Editor 14/14、Board 18/18、200 画板 13/13、Import 11/11、Render 2/2（两组像素差 0）、完整旅程 11/11。完整旅程在 AI 开启服务上仅验证草稿，不提交模型任务。
- 真实 AI 浏览器：9/9，239.67 秒；报告 `tests/e2e/.artifacts/ai-creation-20261031-062602-ec0704/report.json`。两个真实模型回合，无自动重试、无伪造接口响应、无页面或 HTTP 错误。
- 创建回合 `e3163cd7-e86e-434d-9214-93732ccb7cd1`：2 张 1080×1080 画板，分别 8/15 个可编辑图层，精确“晨光咖啡”文字和私有 coffee 资产引用。重开后保留；编辑器真实改字、保存，下载 PNG 777,216 B，尺寸和任务成功状态均核对。
- 修改回合 `31fe3b4f-9081-4cff-958a-ae3b6820fd72`：生成提案期间原 revision 3 不变；预览含“暮色咖啡”，应用后 revision 4，旧版本全部保留。已实际目视查看生成作品及修改预览截图。
- 第三次 UI 提交在 Worker 启动前取消，attempts=0、无沙箱，不产生模型调用；10 秒观察无迟到画板。另独立真实运行时取消验证 `tests/ai/.artifacts/cancellation.json` 确认正在执行的沙箱被 kill 后返回 `SandboxNotFoundError`；不把队列取消误称为运行中沙箱终止。
- 两个产品执行的 sandbox `ie46vyu2fcn3tmv2js4jl`、`ijes1lbnfj7a3f79m7f6b` 均已完成清理，model/thread/usage 记录持久化。
- 并发专项：7/7，44.696 秒，额外仅 1 次真实 create/count=1；报告 `tests/e2e/.artifacts/ai-board-race-20261031-063435-6b087e/report.json`。故障注入仅延迟真实 GET 响应 634.761 ms，未修改 body/status、无伪造产物。响应到达后拖动继续，松手后便签最终位置与 AI 画板一起保存；单步撤销、重做及刷新均保留 AI 画板。脚本 `tests/e2e/ai_board_concurrency.py --allow-paid-ai`，不自动重试付费回合。
- 最终类型、SSR/原型检查、构建通过；单元测试 62/62，包含三方合并、历史重基、完整数量校验、mutation 后刷新失败与脱敏。最终集成 200 画板 production smoke 六项预算通过，见 Board 验收末节。
- 开发配置优先级修复后再次运行完整 API 55/55（53.40 秒），独立数据库及 9 个专属 S3 对象均清理。不使用 `--env-file` 的真实 API/Worker 启动已验证，health 为 `aiEnabled:true`；进程显式 `AI_ENABLED=false` 仍优先。E2B 官方 SDK 最终查询 `purpose=designx-ai-turn` 的活动沙箱数为 0。
