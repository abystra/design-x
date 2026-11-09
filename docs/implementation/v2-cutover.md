# 本地 R2 与 Runner v2 默认切换

日期：2026-11-09。按用户要求保留既有项目，本地启动各角色验证；没有构建镜像或执行生产部署。

## 数据保护与切换

切换前暂停 API 与 Worker 写入。数据库基线为 241 个项目、1,139 份文档、1,265 个文档历史版本、163 条素材记录与 86 个素材版本。`database-before.dump` 已恢复到独立临时数据库，原项目、文档、文档版本、素材版本及 Agent 回合逐行摘要一致，随后删除临时恢复库。原库保持不变。

本机 SeaweedFS 与 R2 的主桶均名为 `designx`。此次采用暂停写入后的完整镜像，验证完成后才切换 endpoint，避免逐项迁移期间同名桶不能区分来源的问题：

| 原桶 | R2 目标桶 | 路径处理 |
|---|---|---|
| `designx` | `designx` | 保留原 key |
| `designx-staging` | `designx` | 增加 `_legacy/designx-staging/` |
| `designx-legacy-migration-test` | `designx` | 增加 `_legacy/designx-legacy-migration-test/` |

共 649 个对象、175,014,326 字节全部复制并逐对象核验大小、SHA-256 和 Content-Type；复制结束再次检查源清单没有变化。源对象未删除。历史附加桶通过 `S3_BUCKET_ALIASES_JSON` 解析，不改写不可变版本或旧任务记录。目标已有不同内容时迁移立即停止，禁止覆盖。

数据库中 22 条测试身份的旧素材记录原文件在切换前已缺失，且都没有素材版本；审计结果及精确 ID 清单保留，未删除记录、伪造文件或生成版本。其余存储引用审计确认 131 个成功导出、53 份导出冻结素材、14 个生成暂存引用、15 个迁移原对象均可读取。成功导入后已按原流程删除的 12 个输入包和 3 个尚未上传的会话不视为迁移数据丢失。

69 条可用旧素材已完成版本回填；明确排除的 22 条缺失记录中，11 条仍在素材库、11 条已软删除。其他缺失文件默认报错停止。原文档及历史引用无需改写。新增版本路径、旧路径及回滚状态由 `storage_migrations` 记录。切换后再次核验全部旧项目、文档、文档版本、素材版本和 Agent 回合，逐行摘要与备份一致。

## 默认配置与启动

主 `.env` 已配置用户授权的 R2 `designx` 桶；本地暂存与正式对象分路径使用同一私有桶。`DESIGNX_RUNNER_V2=true`，固定模板为 `nmz2omb8ebmzkis6mq8c:dad74640-ea56-4f38-9abc-18682f293968`。既有模型和密钥保留，OpenAI 图片单独计量。生产双桶要求不因此改变。

切换前没有活动或受理未知的旧 Agent attempt；28 条业务已终结的残留传输任务已取消，业务历史和未知供应商成本记录保留。原有一条排队中的 Renderer 任务由正常 Worker 处理成功，PNG 写入 R2。

```sh
pnpm dev:v2
```

该命令启动 Web、API、生成、媒体、Agent、导入、Renderer 七个独立进程。浏览器入口为 `http://127.0.0.1:5173`，与用户已配置的 R2 CORS Origin 一致。

普通 `pnpm test:unit`、`pnpm test:api` 不加载主 `.env` 或 `.env.ai.local`，禁用真实模型调用；API 回归使用独立临时 PostgreSQL 数据库及三个唯一的本地 S3 桶。缺省启动使用本机已有镜像的临时 S3 容器，只绑定随机 loopback 端口，不构建或拉取镜像；结束后清理本轮库、桶、容器和数据卷。指定 `TEST_S3_ENDPOINT` 可使用另一个本地测试服务。原本地 S3 的 volume 数量已到上限，本次未重启或修改原服务。真实默认配置的完整流程使用显式 `node --import tsx scripts/verify-default-workflow.mjs --live`；它持久化请求及幂等键，未知受理不会自动重发。

## 真实完整流程

`artifacts/v2/cutover/default-workflow.json` 的 8 项检查通过，全部使用本机常驻的独立角色，没有通过测试代码直接调用 Worker handler：

1. 认证 API 与能力目录确认默认图片、可编辑设计和直传均可用。
2. 真实 Chromium 从 `127.0.0.1:5173` 签名 PUT 到 R2，媒体 Worker 冻结、校验并摄取。
3. 一次真实 OpenAI `images.edits` 使用固定模型和参考图，生成图片进入 R2 正式版本及 Board。
4. E2B 通过项目 matfs 素材创建独立图片、品牌、标题、副标题图层。
5. 修复后连续两轮复用同一沙箱和原生 thread，新建版本并保留前一画板。
6. 真实 Editor 修改中文标题并保存，新 revision 可重新读取。
7. 独立 Chromium Renderer 从固定 R2 素材版本导出 960×720 PNG；下载字节与成果 SHA-256 一致。
8. 返回工作区恢复生成、Agent 和导出活动；图片供应商调用数为 1，配额占用归零、使用量为 1。

导出文件为 `artifacts/v2/cutover/default-workflow-export.png`，Editor 与工作区截图位于同一目录。验收项目和成果保留在专用测试账号中，私有登录信息单独保存，不写入公开报告。OpenAI 原始 usage 已记录；未配置金额费率，成本仍为 unknown。

本轮真实续接发现并修复宿主准备顺序：旧只读 FUSE 必须先卸载，再初始化挂载目录；卸载失败仍阻止新原生调用。同时，同 attempt 的观察者恢复保留原 R2 网络授权与挂载，新业务回合才重新授权。固定模板不变，无需重新构建。`resume-mount-diagnostic.json` 保存无模型 E2B 对旧错误的复现及修复验证。

上一回合已经提交文档、但 Worker 仍在暂停沙箱时，API 现在前置返回 `SESSION_BUSY` 和明确的收尾提示，不创建随后会失败的新任务。验收先等待 attempt 关闭、session paused 再提交续轮。末轮新 attempt 的 matfs 缓存已包含正确 SHA-256 的实际图片字节；诊断未触发额外下载或模型调用，核验后沙箱恢复 paused，证据为 `material-read-proof.json`。

最初的首轮成功与下一轮准备失败均保留。失败发生在 native 执行前，0 条原生事件；该沙箱按失败策略清理。修复后明确重试原失败回合，建立新上下文，再用后一轮验证实际的同 VM/thread 续接。真实 Agent 模型执行共 3 次，图片调用仍只有 1 次，未将新上下文伪装成原 thread 恢复。报告 `recovery` 保存原始失败及重试边界。

## 私有证据与回退

最终回归：`pnpm test:unit` 100/100、默认 `pnpm test:api` 81/81；`pnpm typecheck`、`pnpm check`、`git diff --check` 均通过。最终 API 回归使用自动创建的独立临时 S3，正常退出后清理本轮数据库、桶、容器及匿名卷。`data-preservation.json` 在真实流程之后再次确认全部原有项目、文档、版本与 Agent 回合摘要不变；新增验收数据不计入原有基线。

证据目录为 Git 忽略的 `artifacts/v2/cutover/`。含原配置备份、数据库备份和恢复记录、完整对象镜像清单、历史缺失审计、素材回填日志及迁移后数据保留核验。配置文件与登录状态权限为 0600，不提交凭据。

切换后已有新 R2 写入时，**不能仅恢复 `.env.before`**。必须先停写、排空或对账执行，再把当前 R2 主桶全部反向复制及核验到本地同名桶；保留别名和暂存桶配置，确保新旧对象都能读取。具体操作和限制见 [R2 配置与安全回退](../../infra/r2/README.md)。回退不删除新表、历史版本或新对象，也不重放未知请求。
