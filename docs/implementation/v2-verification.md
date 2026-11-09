# Design X v2 实现与验收记录

日期：2026-11-08，默认存储与 Runner 切换更新于 2026-11-09。范围为用户批准的 v2 改造，后续明确以本地启动验证为准，不要求应用镜像构建。本次没有部署生产。切换证据见 [本地默认切换记录](v2-cutover.md)。

## 已交付

- 增量数据库迁移 0005–0012；保留旧项目、文档、版本、Agent 记录与兼容读取。
- 服务端能力目录、真实图片生成/编辑、配额账本、部分成功、未知受理、摄取单独重试、三个结构化 Recipe。
- 独立图片 Board 条目、可编辑文案与品牌层、项目活动、原生提问/回答/停止、保存 revision 确认和既有并发保护。
- R2/S3 私有 staging 直传、条件复制冻结、版本化素材、项目授权、历史别名稳定、复制/核验/切换/回滚及保守清理。切换后旧桶使用显式配置的只读旧客户端，不把旧对象路径误送到新存储。
- E2B 固定模板、WorkX RPC/matfs 源码与协议移植、事件 journal、会话、租约、fence、工具幂等与原生恢复边界。
- 独立进程角色、CI、可选容器定义、运维报告、人工成本核对、数据库备份与独立空库恢复工具。

## 本地自动化

| 验证 | 证据 | 结果 |
|---|---|---|
| TypeScript（含运维脚本、E2B 构建和验收脚本） | `pnpm typecheck` | 通过 |
| 单元测试 | `pnpm test:unit` | 100 项通过（11-09）；含镜像迁移、测试隔离、素材挂载和网络恢复 |
| API 与真实 PostgreSQL/S3 集成 | `pnpm test:api` | 81 项通过（11-09）；临时库/S3 全程隔离，正常退出与清理 |
| 生成故障专项 | `v2-generation.integration.test.ts` | 6 项通过；部分成功、配额、重复投递、24 小时未知释放、撤权、目标变化、跨租户 |
| 并发独立审查专项 | `v2-review.integration.test.ts` | 5 项通过；过期审核不提交、重试多 cycle、旧媒体 token、冻结版本、取消/回执锁竞争 |
| 存储专项 | `v2-storage.integration.test.ts` | 7 项通过；真实直传/条件复制、摘要、版本、别名批量迁移/重复回滚、GC |
| Python Runner | `python3 -m pytest runtime/runner/tests -q` | 34 项通过 |
| Go matfs | `go test ./...` | 8 项通过；含实际传输字节预算的失败路径 |
| 产品与兼容浏览器 | [v2-product.md](v2-product.md) | 75 项/组通过 |
| 既有静态检查、前端构建 | `pnpm check`、`pnpm build` | 通过；前端仍有已有的大包提示 |

浏览器回归包括 200 画板/10000 节点、Editor 离线草稿与两页冲突、模板→Studio→Editor、真实上传/PNG/PDF、跨租户、Board 包导入导出、原生 tldraw、原生提问界面刷新恢复。两组真实 Editor/Renderer 对照像素差均为 0。

11-09 的默认配置切换另完成 8 项真实全流程检查：浏览器 R2 直传、OpenAI 参考编辑、E2B 带素材可编辑设计、同 VM/thread 续改、Editor 保存、常驻 Renderer PNG 导出和活动/配额核对。修复只读挂载准备顺序、观察恢复 R2 网络授权和提交后暂停收尾窗口；完整失败、显式重试及最终通过证据见 [v2-cutover.md](v2-cutover.md)。本轮未重复既有全部 75 项浏览器夹具，也未构建镜像。

最终全量回归包含新增的跨两轮计量、重复事件与原生进度覆盖检查。六个临时数据库测试套件统一等待连接真正关闭后再删库，连接泄漏会明确失败，不使用 FORCE 掩盖异常。浏览器夹具增加按身份核验的 finally 清理；本轮遗留的五条虚构执行已关闭，项目、文档和产物保留。运维快照见 `artifacts/v2/operations-final.json`，汇总验收记录为 `artifacts/v2/local-verification.json`。

UI 测试明确使用数据库提问/生成夹具；不能将其当成模型服务验收。以下供应商记录单独列出。

## 真实 OpenAI

`pnpm verify:images --live` 使用用户提供的 OpenAI 凭据，两次付费请求：

1. 固定 `gpt-image-2.5-sunburst-2026-09-08`、medium 的真实文生图。
2. 使用第一张不可变版本的真实 `images/edits` 参考编辑。
3. 两次产物分别经持久化响应暂存、私有 S3 staging、sharp、输出审核和正式素材摄取，成为独立 Board 图片。
4. 第二张加入中文独立文字图层画板，经过共享 Chromium Renderer 导出成功。

证据：`artifacts/v2/image-acceptance.json`，原始 token usage 已记录；本次使用本地 S3 兼容存储。未提供内部费率表，金额维持 NULL/unknown，没有把实际调用成本记为零。模型可用性检查返回 200，未降级或替换模型。

## 真实 E2B / Codex / matfs

固定 WorkX 来源：`f81c31a3b09d13d8955248ec7bdefbdfc1f08a6e`；目标 Codex 为 `0.166.0`，不继承 WorkX `0.144.0` 的验收结论。

`infra/e2b/acceptance-2026-11-08.json` 记录真实 DeepSeek/Codex 执行：观察者在 native turn 开始后断开，再连接相同 attempt；动态业务工具调用进入 TS 并返回原生结果；真实可编辑成果；同 VM、同原生 thread 的暂停/续接；第三轮原生提问期间停止在 5.59 秒内完成。测试 VM 已清理。

后续独立审查修复 matfs 失败读取不计费的漏洞：摘要失败、超长一字节校验和中断传输均按实际网络字节计入预算，不能靠重复篡改读取绕过预算。

最新模板：`nmz2omb8ebmzkis6mq8c:dad74640-ea56-4f38-9abc-18682f293968`。

最新 matfs SHA-256：`ca52fe61ac6a9d26f2e3a94dac02e7b1b6a9e9f6b523eb5238914b5f77e1ea26`。

新二进制、E2B FUSE 内核、只读挂载、root 凭据/缓存不可读已真实验证，记录在 `infra/e2b/material-budget-acceptance-2026-11-08.json`。Runner/validator/Codex 定义与前一次真实多轮验收源码摘要一致。

随后使用用户授权的真实 R2 `designx` 桶补完带素材的 E2B 验收，`artifacts/v2/e2b-r2-acceptance.json` 的 **13 项全部通过**：准确大小/SHA、清单外不可见、只读、root 凭据/缓存隔离、跨项目拒绝、项目 B 独立授权、篡改失败仍计读取预算、修复后新 attempt 可读、字节预算、过期凭据、非法清单失败，以及挂载失败阻断原生提交。真实 Agent 打开挂载字节并返回包含固定图片版本和实际摘要的可编辑成果。VM 和额外对象均已清理；沿用上述固定模板，没有重新构建镜像。

`scripts/verify-agent-workflow.ts` 还完成了真实业务闭环，**8 项通过**：认证 API 创建 v2 回合 → `runBusinessJob/runAiTurn` → 原生事件持久化 → 会话暂停/释放执行权 → Artboard、历史版本、Board 和 `asset_version_refs` 同步提交 → 刷新恢复 → Renderer 读取 R2 固定版本并完成 PNG 导出和认证下载。没有新增 OpenAI 图片调用。证据为 `artifacts/v2/agent-workflow-acceptance.json`，可视产物为 `artifacts/v2/agent-workflow-export.png`。

真实回合发现 Codex 的 `total/last` 嵌套 token 字段未被旧平铺适配器保存。现已修复为与原生事件游标同事务持久化：新 thread 基线为 0；续接使用前一同项目、同 thread 回合的原生累计值，固定当前 attempt 基线；重复事件、重连和最终输出不会叠加累计值。无法确认基线或字段时保留 unknown，不补零。已用原先持久化的 9 条事件幂等重放补记，得到输入 102099、输出 2819、缓存输入 93440；未追加模型请求。`artifacts/v2/agent-usage-reconciliation.json` 与 workflow 报告明确标记原始 `{}` 和修复后重放，不伪称首次实时计量已正确。

## R2 当前环境状态

用户授权复用 `.env.r2-test.local` 的凭据值，并提供 `designx` 桶。已映射为 Git 忽略、权限 0600 的 `.env.r2.local`，使用 Design X 的 `S3_*` 变量。此次本地验收采用显式 `--single-bucket-test`：上传暂存、正式版本与项目内容池分路径，并使用随机测试 workspace 前缀。生产仍要求独立 staging/正式桶；单桶验收开关禁止用于 production。

真实 R2 签名 PUT、条件复制冻结、媒体摄取、短期只读凭据、摘要、跨项目拒绝、禁止写入及凭据过期检查已通过。旧的 `designx-v2-assets/staging` 403 是历史尝试，保留在 `artifacts/v2/r2-bootstrap.json`，不再代表当前 `designx` 数据面权限。

用户补齐 PUT/HEAD 和请求头后，**R2 真实验收 7/7 通过**：OPTIONS 返回 204，允许 Origin 精确匹配 `http://127.0.0.1:5173`；真实 Chromium 从该页面执行签名 PUT 返回 200，随后完成冻结、摄取和权限检查。没有禁用浏览器安全设置，也没有用服务端上传代替浏览器结果。报告为 `artifacts/v2/r2-acceptance.json`，`status=passed`、`cleaned=true`；新测试数据已清理。桶级设置由用户保存，程序未覆盖原规则。配置与命令见 [R2 本地验收说明](../../infra/r2/README.md)。

2026-11-09 按用户要求，主 `.env` 已切换到 R2 `designx` 和固定新版 E2B 模板。旧本地 S3 与新 R2 主桶同名，因此先暂停写入、完整镜像并核验 649 个对象，再整体切换 endpoint；历史附加桶使用独立前缀别名。逐项跨 endpoint 的同名桶迁移仍拒绝执行。69 条可用旧素材完成不可变版本回填；全部旧项目、文档和版本逐行摘要不变。22 条原文件已缺失的历史测试素材记录原样保留，其中 11 条已软删除；没有修改 WorkX 数据。具体证据和回退方式见 [默认切换记录](v2-cutover.md)。

真实领域回合及用量取证完成后，旧保留 fixture 的数据库 workspace 和 R2 对象也已回收，复查该前缀为空。记录在 `artifacts/v2/r2-domain-fixture-cleanup.json`；E2B 和 workflow 报告标记 `fixtureCleaned=true`。PNG、原生用量证据和验收报告继续保存在本机，不保留测试 VM 或云端业务夹具。

## 备份、清理与发布

最新 12 个迁移的备份已实际恢复到本轮创建的独立空数据库，逐项核对真实 OpenAI 项目的两份文档版本、两个素材版本及其路径、桶和摘要后，删除恢复测试库。原库及原对象未修改。证据 `artifacts/v2/backup-restore.json`；本次备份为 6,522,207 字节，保留在 Git 忽略的本机 artifacts 下。

清理工具默认为 dry run；集成测试验证仅删除达到保留期的已登记孤儿对象，不删除历史版本、迁移原对象或可恢复产物。人工供应商核对默认 dry run，明确 `--apply` 才写入审计与真实成本，不重发模型。

云端存储准备和验收不会自动创建桶或改写全局 CORS，浏览器权限通过实际 OPTIONS 验证；仅本机开发 S3 自动配置 CORS。重复执行已完成的存储回滚为幂等空操作，不覆盖随后新增的素材版本。

本轮按用户要求不继续应用镜像构建；可选 Docker/compose 配置保留为后续部署材料。生产环境切流、真实生产备份恢复、压测与发布审批没有执行。

发布前先关闭新派发并排空旧执行，分别灰度存储、图片和 Runner。未知受理不能直接重发或换宿主；新 Runner 开关与固定模板配置需要在真实项目素材授权链路通过后再整体启用。回退保持增量表和版本对象，仅关闭新派发并切回兼容版本；存储按 migration 映射逐项回退。

## 本地运行入口

```sh
pnpm infra:up
pnpm db:migrate
pnpm dev:v2
```

`dev:v2` 启动 Web、API、生成、媒体、Agent、导入和 Renderer 的独立角色。真实模型需要本地已有的私密配置；OpenAI 图片和既有 DeepSeek Agent 分别配置和计量。本机主 `.env` 已完成 R2 与 Runner v2 切换，`.env.r2.local` 继续保留为显式验收 profile。变量与灰度开关见 `.env.example`。普通 unit/API 回归使用独立本地资源，不读取云端默认配置。

运维：`pnpm ops:report`、`pnpm storage:migrate --workspace ID`、`pnpm storage:cleanup`、`pnpm db:backup`、`pnpm ops:reconcile`。迁移/清理/成本核对请先检查 dry run 输出；迁移不清空历史项目。
