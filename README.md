# Design X · 灵感设计室

保留现有高仿真 UI 的创作系统：账户与个人空间、模板、tldraw Board、精细编辑器、项目/版本、素材与品牌、AI 可编辑设计、真实后台处理和导出。业务数据在 PostgreSQL，文件在 S3 兼容对象存储，任务由独立 Worker / Renderer 执行。

AI 已接入 **E2B 官方 SDK → 指定 Codex 模板内 Harness → Codex SDK → DeepSeek**。支持参考图创作、真实可编辑画板、修改提案预览/应用、取消和持久化回合；通过真实浏览器与模型验收。详见 [AI 创作实现](docs/implementation/ai-creation.md)、[ADR-0001](docs/adr/0001-codex-e2b.md)。

基础链路提交为 `44fcd0e`、`ead7d15`、`2bcc3f0`。本轮分三步交付：Board 便签/分区 `5f7a263`，持久化项目导入 `2291383`，最后汇总验收与文档。架构目录描述的长期目标不等于全部实现，具体完成度见 [阶段进度](docs/implementation/progress.md)。

## 本地启动

已验证环境：Node.js 22.22.3、pnpm 10.20.0、Docker。数据库与存储只绑定本机地址，使用专门的开发卷，不覆盖其他项目。

```bash
corepack enable
pnpm install --frozen-lockfile
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose -f infra/compose/docker-compose.dev.yml up -d --wait --wait-timeout 60
pnpm db:migrate
pnpm exec playwright install chromium
pnpm dev:all
```

打开 [Design X](http://127.0.0.1:5173/)，创建自己的账户，无预置通用密码。端口：Web 5173、API 3001、PostgreSQL 55432、S3 58333。迁移需要数据库建表/角色权限；上述 `--wait` 等待 PostgreSQL healthy，SeaweedFS 只检查容器运行状态。应用启动后应看到 `Design-X media worker ready` 和 `Design-X renderer ready`；首次上传/导出验证存储与处理链路。

使用 `127.0.0.1:5173` 与示例 `WEB_ORIGIN` 保持一致。改主机名或端口时，需要同步调整 `.env` 和 Vite 配置中的代理/端口。`/api/health` 返回 `status: ok` 只证明 API 可达；`aiEnabled` 反映配置开关，不代表模型或后台处理全部健康。

启用 AI：在 Git 忽略、权限 0600 的 `.env.ai.local` 配置 `AI_ENABLED=true`、`E2B_API_KEY`、`DEEPSEEK_API_KEY`、`E2B_TEMPLATE_ID=u1yrkaokyjzef8qchho5`、`DEEPSEEK_MODEL=deepseek-flash`。开发进程按“外部进程环境 → `.env.ai.local` → `.env`”取值，生产仅从外部环境注入；不要把真实密钥填进示例文件、前端变量或代码。修改配置后重启 API/Worker。

各进程也可单独运行：`pnpm dev:web`、`pnpm dev:api`、`pnpm dev:worker`、`pnpm dev:renderer`。仅运行原有 `pnpm dev` 会启动前端，其他进程仍须运行。

停止应用使用 Ctrl+C；`pnpm infra:down` 停止基础设施并保留数据卷。不要用 `down -v`，除非有意删除本项目开发数据。

## 可用旅程

1. 模板灵感 → 预览模板 → 使用模板 → 修改文字/图片/图层 → 自动或手动保存 → 刷新重开。
2. 开始创作 → Board → 添加画板、模板、素材或便签 → 创建分区并管理成员 → 平移缩放、多选、对齐、复制/移除、撤销重做 → 精细编辑 → 返回原画布。移动分区带动成员，删除分区保留内容；成员通过明确加入/移出改变归属。
3. 资产库 → 上传真实图片 → 后台校验/缩略图 → 素材引用；管理收藏、创作参考、品牌色、字体和 Logo。
4. 项目 → 文件夹、重命名、移动、最近打开、回收站和恢复。注销后重登仍保留。
5. 编辑器 → 命名版本 / 恢复 → 导出 PNG、JPEG、WebP、单页 PDF、原生 `.dxproj`；右上角创作动态查看后台状态、重试和下载。SVG 另有 API 导出，采用含 DOM 的 `foreignObject`，不作为通用矢量编辑器交换格式承诺。
6. Board → 项目包下载 → 另一账户“我的项目”导入 → 后台重建新项目、文档及私有素材 → 打开继续编辑。关闭导入弹窗后已接收的任务仍继续，可从创作动态打开结果。
7. Agent → 添加参考素材和需求 → 生成 1–3 个可编辑方案 → 精细编辑/导出；选中画板“继续修改” → 预览提案 → 检查版本后应用。期间移动/便签改动与新增结果合并，撤销不误删服务端 AI 成果。

素材上限每张 10 MiB，PNG/JPEG/WebP/GIF；GIF 摄取首帧。被设计、历史版本或品牌/参考引用的素材不能删除。导出绑定提交时的版本，后续编辑不改变已排队文件。断网时已打开编辑器的未同步改动缓存在 IndexedDB，恢复网络后可重试；冲突提供保留副本或使用最新版本。

原生项目包为 JSON v1（不是 ZIP）：源文件最多 40 MiB，内嵌素材解码后合计 30 MiB、单图 10 MiB，最多 100 张画板、200 个素材、10,000 个图层；未知版本拒绝。图片实际解码并保存为新空间的私有文件。失败源包保留供任务重试，尚未提供长期失败文件的定时清理。完整限制及实测范围见 [Board 与导入说明](docs/implementation/board-import.md)。

Board 默认使用 tldraw 5.6.0 的原生框选、拖动、缩放与相机，保留原高仿真界面、业务历史和真实文档预览。视口外保留轻量 SDK shape，卸载重内容；全选、分区成员和组织历史覆盖完整数据。显式比较入口为 `/?boardEngine=legacy#studio/项目ID`。本轮实现、原生交互专项和 200 画板生产性能三轮见 [tldraw 接入验收](docs/implementation/tldraw-board.md)；此前性能基线见 [Board 性能验证](docs/implementation/board-performance.md)。项目包的 100 画板预算保持不变。

## 验证

```bash
pnpm typecheck
pnpm check
pnpm test:unit
pnpm build
# 真实 PostgreSQL + S3；测试会启动自己的 worker/renderer。
# 推荐 DATABASE_URL 指向独立测试库，避免消费开发环境（包括 AI）的任务。
# 若复用开发库，应先停止长期 worker/renderer，且没有待执行的 AI 任务。
pnpm test:api
# 重新启动 pnpm dev:all 后运行浏览器旅程。
python3 -m pip install -r tests/e2e/requirements.txt
pnpm test:e2e
pnpm test:editor
pnpm test:render
pnpm test:board
pnpm test:import
# 下列命令显式调用真实收费沙箱和模型，不属于普通单测：
pnpm verify:ai-runtime
python3 tests/e2e/ai_creation.py --allow-paid-ai
```

`pnpm check` 包含页面结构检查以及保留的原型规则/会话测试夹具；这些夹具不参与产品执行，也不能代替真实服务验收。完整浏览器步骤、实际结果与限制见 [验收指南](docs/implementation/verification.md)、[执行记录](docs/implementation/verification-results.md)、[阶段进度](docs/implementation/progress.md)。

## 工程边界

- `src/`：现有前端渐进迁移，保留原 CSS、页面和交互；`apps/web` 是工作区入口。
- `apps/api`、`apps/worker`、`apps/renderer`：HTTP/SSE、媒体工作进程、Chromium 导出进程。
- `apps/harness`、`packages/ai-runtime`：E2B 内 SDK 工具执行；控制面生命周期、事件与文件成果校验。
- `packages/doc-core`、`doc-render`：版本化文档校验、正向/反向操作、统一 DOM/SVG 渲染。
- `packages/server-domain`、`server-infra`：领域业务、RLS、事务、队列和 S3。
- `db/migrations`、`infra/compose`：可重放 SQL 迁移、本地 PostgreSQL / SeaweedFS。

当前可本地运行和联调，尚未作公网生产部署验收。`pnpm build` 只构建 Web 静态文件；API、Worker、Renderer 的生产镜像、进程管理、反向代理及部署流水线尚未交付。邮箱验证/找回、OTP、通用自动冲突解决、定时素材 GC、多人实时协作、独立图片/视频模型、完整配方与计费未实现。低倍率仍渲染真实图层，无缩略图 LOD。生产需独立配置数据库角色、存储凭证、HTTPS、备份与 tldraw 许可，不能使用示例开发密码。
