# 非 AI 阶段本地验收

本指南验证真实 PostgreSQL、S3 兼容存储、API、Worker、Renderer 与浏览器链路。AI、E2B、Codex SDK 不在本轮运行验收范围。测试不伪造 HTTP API 响应，也不会把前端演示规则作为生成结果。编辑器专项包含明确的请求中止故障注入，范围见下文。

## 准备与启动

在仓库根目录安装依赖、启动基础设施并迁移数据库；已有 `.env` 时保留其中配置，不要覆盖。

```bash
pnpm install --frozen-lockfile
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose -f infra/compose/docker-compose.dev.yml up -d --wait --wait-timeout 60
pnpm db:migrate
pnpm exec playwright install chromium
pnpm dev:all
```

前置环境为 Node.js >= 22.12、pnpm 10.20.0、已启动的 Docker 和 Python 3。已验证的本机版本为 Node.js 22.22.3、Docker Compose 5.4.0；其他操作系统未做完整启动验收。`--wait` 等待 PostgreSQL 健康，SeaweedFS 没有 Compose healthcheck，因此容器 running 不等于 S3 读写已验证。

已有服务运行时不要重复启动同端口。先确认 `http://127.0.0.1:5173/api/health` 返回 `status: ok` 和 `aiEnabled: false`。素材摄取需要 media worker，文件导出需要 renderer；仅 API 健康不能证明二者可用。两个进程分别输出 `Design-X media worker ready`、`Design-X renderer ready`，实际上传与导出用例再验证存储和任务执行。数据库迁移应在启动应用进程前完成；开发角色需要建表/建角色权限。

示例端口为 Web 5173、API 3001、PostgreSQL 55432、S3 58333，浏览器地址应与 `WEB_ORIGIN=http://127.0.0.1:5173` 一致。`pnpm build` 仅产出 Web 静态构建，不包含后端生产部署。`pnpm infra:down` 保留开发数据卷；不需要删除卷来重复验收。

Python 浏览器测试需要 `playwright`：

```bash
python3 -m pip install -r tests/e2e/requirements.txt
```

测试默认复用 Node Playwright 的 Chromium 路径，避免 Python Playwright 浏览器版本缓存不一致。必要时显式设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`，指向可执行文件。

## 自动检查

```bash
pnpm typecheck
pnpm check
pnpm test:unit
pnpm build
# 停止当前 dev:all（或单独启动的长期 Worker / Renderer）。
# API 集成测试自行创建 API 实例及后台子进程，基础设施保持运行。
pnpm test:api
# 另一个终端重新 pnpm dev:all，待各进程 ready 后继续。
pnpm test:e2e
pnpm test:editor
pnpm test:render
pnpm test:board
pnpm test:import
```

- `test:unit`：文档 diff/apply 往返与逆向恢复、120 步编辑历史、源文档不被修改、唯一图层 ID、无效排序、尺寸变换、素材引用去重及路径边界。
- `test:api`：串行执行真实 PostgreSQL/S3 集成用例，媒体用例启动独立 Worker/Renderer 子进程。必须停止长期后台进程，避免它们消费测试刻意保留的离线队列；不用关闭或清空 PostgreSQL/S3。
- `test:e2e`（`non_ai_journey.py`）：注册个人空间 → 模板实例化 → 中文文本编辑并保存 → 清空 localStorage 后刷新重开 → 上传/摄取并写入资产引用 → 命名版本/恢复 → PNG/PDF 下载 → 文件夹归档/品牌保存 → AI 未接入状态 → 注销重登 → 第二账号资源隔离。
- `test:editor`（`editor_interactions.py`）：分组/解除分组、对齐、旋转、裁切、画布尺寸、复制/删除与逆向历史，以及未提交草稿恢复、浏览器模拟离线和双标签冲突。是否通过以实际执行记录为准。
- `test:render`（`render_consistency.mjs`）：比较两份固定文档在实际编辑器 DOM 与独立 Renderer 中的 PNG，覆盖中英文字体/换行、图片适配、旋转、透明度、裁切、隐藏；这是同机 Chromium、1× 的有限样本。
- `test:board`（`board_features.py`）：便签/分区、显式成员加入移出、混合拖动去重、复制 ID 映射、删除分区保留内容、撤销重做/刷新、真实 409 草稿下载、`.dxproj` 真实下载及空Board从项目列表重开。`--core` 只跑 5 项早期检查并报告 `partial`，正式专项不要带该参数。
- `test:import`（`project_import.py`）：双账户真实项目包导出/导入、Board-only素材、全量支持引用映射、私有权限、刷新续编与再导出、非法版本/文件、390px弹窗/焦点和关闭弹窗后后台完成入口。API准备真实夹具，UI完成导出、导入、编辑操作，无响应伪造。限制与结果见 [Board 与导入验收](board-import.md)。

`pnpm check` 包含结构检查和原型规则/会话测试夹具，不代表产品已接入 AI。API 测试、浏览器旅程、专项交互和渲染对比是不同证据，不能互相代替。

导入 API 集成测试会创建并删除临时独立数据库，因此测试连接需要 CREATEDB/删除自有测试数据库权限及迁移权限；默认 Compose 开发角色满足要求。测试只清理自己创建的数据库和 S3 前缀。真实浏览器套件应依次运行，不并行轰击同一开发 API；共享 IP 的每分钟限流可能令本应 404 的隔离断言收到 429。遇到时保留严格断言，等窗口恢复后单独重跑，不关闭限流或把 429 当成隔离测试通过。

导入浏览器测试默认创建两个新隔离账户。重复验收触发注册限流时，可用 `python3 tests/e2e/project_import.py --accounts-file <测试凭据文件>` 复用此前专用测试账户进行真实 UI 登录，仍创建全新 fixture 项目并验证全部跨账户权限；报告会标记 `authenticationMode`，不能把登录结果写成注册成功。凭据文件仅临时保存在仓库外，权限设为 0600，用后删除，不提交、不写入验收报告。格式以脚本 `--help` 为准。

PNG 检查真实文件签名、非空文件及像素尺寸；PDF 检查文件签名和完整结束标记。下载使用浏览器触发的真实导出任务，并核查对应任务成功。其他账号不得读取项目、版本、素材、缩略图、导出或修改项目。

编辑器恢复专项区分两种情形：

- `route.abort` 明确中止项目 PATCH，确保保存没有到达服务端；检查服务端内容/revision 未变，再验证 IndexedDB 草稿在刷新后恢复，解除阻断后可以保存。这是传输故障注入，没有提供伪造的成功响应。
- 独立使用 `context.set_offline(true)` 检查 `navigator.onLine === false`、本地内容保留及重新打开后的处理。浏览器模拟离线不保证请求未提交：本轮服务端 revision 从 1 变为 2，应用保留本地草稿并显示保守冲突，不覆盖服务器。它不能证明所有失败保存都可自动无冲突同步。

双标签用例另行验证真实 409、刷新后保留修改及另存副本。上述用例不要求真实断网时还能从服务器加载整个应用；当前未提供完整离线应用壳。

`python3 tests/e2e/non_ai_journey.py --help` 可查看配置。开发阶段可用 `--skip-exports`，结果明确标为 `partial`，**不属于完整验收通过**。正式验收必须不带该参数。

## 证据与测试数据

每次浏览器运行在 `tests/e2e/.artifacts/<run-id>/` 写入：

- `report.json`：逐项 passed/failed/skipped、浏览器错误、HTTP 5xx 和项目 ID。
- 页面截图、失败时的 DOM 文本、Playwright `trace.zip`。
- 成功导出的 `export.png`、`export.pdf`。

Board/导入专项分别使用 `board-<run-id>/`、`import-<run-id>/`，另保留 `.dxproj`、冲突草稿和对应报告。原生导入为 JSON v1，源文件40MiB、素材解码后合计30MiB；失败源包为支持重试保留在服务端，当前无定时保留期清理。使用专门测试环境并按测试运行记录管理数据。

这些运行文件被 Git 忽略。测试创建独立的 `e2e-…@example.test` 账号，随机密码只存在运行进程内，不写报告。测试数据保留供复核，不自动清空已有数据库。重复运行可能触发注册限流；应使用专门测试环境，避免为通过测试关闭生产限流。

查看 trace：

```bash
pnpm exec playwright show-trace tests/e2e/.artifacts/<run-id>/trace.zip
```

## 仍需人工或专项验证的边界

- 与有效原型基线逐页比较相同 1440px 视口，核对布局、字体、菜单和弹窗；功能 E2E 不等于像素一致性验收。
- API 集成测试覆盖排队时 Renderer 离线、持久化取消、重试幂等和旧执行 fencing；这不能推导任意时刻终止进程、断电或数据库/对象存储故障后都能恢复。
- 中文输入法真实组合输入、复杂字体、完整金样库/跨环境渲染一致性、性能规模与移动端，不由上述有限样本证明。
- 线上部署、外部云服务、短信/邮件登录和 AI/Sandbox 均不能由本地测试推断已经可用。

最新执行结果将记录在同目录 `verification-results.md`；该文件必须列出实际运行记录，不把未运行项标为通过。
