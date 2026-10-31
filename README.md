# Design X · 灵感设计室

保留现有高仿真 UI 的非 AI 创作系统：账户与个人空间、模板、Board、精细编辑器、项目/版本、素材与品牌、真实后台处理和导出。业务数据在 PostgreSQL，文件在 S3 兼容对象存储，任务由独立 Worker / Renderer 执行。

AI 执行尚未接入。已确定的后续架构为 **E2B Sandbox → Harness → Codex SDK**，见 [ADR-0001](docs/adr/0001-codex-e2b.md)。产品入口如实显示未接入，不使用规则生成冒充模型能力。

阶段 1 业务持久化与架构已提交 `44fcd0e`；阶段 2 UI 与非 AI 链路已提交 `ead7d15`。架构目录描述的长期目标不等于本阶段全部实现，具体完成度见 [阶段进度](docs/implementation/progress.md)。

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

使用 `127.0.0.1:5173` 与示例 `WEB_ORIGIN` 保持一致。改主机名或端口时，需要同步调整 `.env` 和 Vite 配置中的代理/端口。`/api/health` 返回 `status: ok`、`aiEnabled: false` 只证明 API 可达，不代表后台处理全部健康。

各进程也可单独运行：`pnpm dev:web`、`pnpm dev:api`、`pnpm dev:worker`、`pnpm dev:renderer`。仅运行原有 `pnpm dev` 会启动前端，其他进程仍须运行。

停止应用使用 Ctrl+C；`pnpm infra:down` 停止基础设施并保留数据卷。不要用 `down -v`，除非有意删除本项目开发数据。

## 可用旅程

1. 模板灵感 → 预览模板 → 使用模板 → 修改文字/图片/图层 → 自动或手动保存 → 刷新重开。
2. 开始创作 → Board → 添加空白画板、模板或素材 → 平移缩放、多选、对齐、复制/移除、撤销重做 → 精细编辑 → 返回原画布。
3. 资产库 → 上传真实图片 → 后台校验/缩略图 → 素材引用；管理收藏、创作参考、品牌色、字体和 Logo。
4. 项目 → 文件夹、重命名、移动、最近打开、回收站和恢复。注销后重登仍保留。
5. 编辑器 → 命名版本 / 恢复 → 导出 PNG、JPEG、WebP、单页 PDF、原生 `.dxproj`；右上角创作动态查看后台状态、重试和下载。SVG 另有 API 导出，采用含 DOM 的 `foreignObject`，不作为通用矢量编辑器交换格式承诺。

素材上限每张 10 MiB，PNG/JPEG/WebP/GIF；GIF 摄取首帧。被设计、历史版本或品牌/参考引用的素材不能删除。导出绑定提交时的版本，后续编辑不改变已排队文件。断网时已打开编辑器的未同步改动缓存在 IndexedDB，恢复网络后可重试；冲突提供保留副本或使用最新版本。

## 验证

```bash
pnpm typecheck
pnpm check
pnpm test:unit
pnpm build
# 真实 PostgreSQL + S3；测试会启动自己的 worker/renderer。
# 先停止 pnpm dev:all 中的长期 worker/renderer，避免改变离线队列测试的前提。
pnpm test:api
# 重新启动 pnpm dev:all 后运行浏览器旅程。
python3 -m pip install -r tests/e2e/requirements.txt
pnpm test:e2e
pnpm test:editor
pnpm test:render
```

`pnpm check` 包含页面结构检查以及保留的原型规则/会话测试夹具；这些夹具不参与产品执行，也不能代替真实服务验收。完整浏览器步骤、实际结果与限制见 [验收指南](docs/implementation/verification.md)、[执行记录](docs/implementation/verification-results.md)、[阶段进度](docs/implementation/progress.md)。

## 工程边界

- `src/`：现有前端渐进迁移，保留原 CSS、页面和交互；`apps/web` 是工作区入口。
- `apps/api`、`apps/worker`、`apps/renderer`：HTTP/SSE、媒体工作进程、Chromium 导出进程。
- `packages/doc-core`、`doc-render`：版本化文档校验、正向/反向操作、统一 DOM/SVG 渲染。
- `packages/server-domain`、`server-infra`：领域业务、RLS、事务、队列和 S3。
- `db/migrations`、`infra/compose`：可重放 SQL 迁移、本地 PostgreSQL / SeaweedFS。

当前是可本地运行和联调的非 AI 版本，尚未作公网生产部署验收。`pnpm build` 只构建 Web 静态文件；API、Worker、Renderer 的生产镜像、进程管理、反向代理及部署流水线尚未交付。邮箱验证/找回、OTP、自动冲突 rebase、原生项目导入、定时素材 GC、多人实时协作和后续 AI 执行未实现。生产环境需独立配置数据库角色、存储凭证、HTTPS 和备份，不能使用示例开发密码。
