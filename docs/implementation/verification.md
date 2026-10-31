# 非 AI 阶段本地验收

本指南验证真实 PostgreSQL、S3 兼容存储、API、Worker、Renderer 与浏览器链路。AI、E2B、Codex SDK 不在本轮运行验收范围。测试不会 mock HTTP API，也不会把前端演示规则作为生成结果。

## 准备与启动

在仓库根目录安装依赖、启动基础设施并迁移数据库；已有 `.env` 时保留其中配置，不要覆盖。

```bash
pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm exec playwright install chromium
pnpm dev:all
```

已有服务运行时不要重复启动同端口。先确认 `http://127.0.0.1:5173/api/health` 返回 `status: ok` 和 `aiEnabled: false`。素材摄取需要 media worker，文件导出需要 renderer；仅 API 健康不能证明二者可用。数据库迁移应在启动应用进程前完成。

Python 浏览器测试需要 `playwright`：

```bash
python3 -m pip install playwright
```

测试默认复用 Node Playwright 的 Chromium 路径，避免 Python Playwright 浏览器版本缓存不一致。必要时显式设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`，指向可执行文件。

## 自动检查

```bash
pnpm test:unit
pnpm test:api
python3 tests/e2e/non_ai_journey.py
```

- `test:unit`：文档 diff/apply 往返与逆向恢复、120 步编辑历史、源文档不被修改、唯一图层 ID、无效排序、尺寸变换、素材引用去重及路径边界。
- `test:api`：真实数据库集成用例；以运行输出为准，不能将其与真实浏览器结果混为一项。
- `non_ai_journey.py`：注册个人空间 → 模板实例化 → 中文文本编辑并保存 → 清空 localStorage 后刷新重开 → 上传/摄取并写入资产引用 → 命名版本/恢复 → PNG/PDF 下载 → 文件夹归档/品牌保存 → AI 未接入状态 → 注销重登 → 第二账号资源隔离。

PNG 检查真实文件签名、非空文件及像素尺寸；PDF 检查文件签名和完整结束标记。下载使用浏览器触发的真实导出任务，并核查对应任务成功。其他账号不得读取项目、版本、素材、缩略图、导出或修改项目。

`python3 tests/e2e/non_ai_journey.py --help` 可查看配置。开发阶段可用 `--skip-exports`，结果明确标为 `partial`，**不属于完整验收通过**。正式验收必须不带该参数。

## 证据与测试数据

每次浏览器运行在 `tests/e2e/.artifacts/<run-id>/` 写入：

- `report.json`：逐项 passed/failed/skipped、浏览器错误、HTTP 5xx 和项目 ID。
- 页面截图、失败时的 DOM 文本、Playwright `trace.zip`。
- 成功导出的 `export.png`、`export.pdf`。

这些运行文件被 Git 忽略。测试创建独立的 `e2e-…@example.test` 账号，随机密码只存在运行进程内，不写报告。测试数据保留供复核，不自动清空已有数据库。重复运行可能触发注册限流；应使用专门测试环境，避免为通过测试关闭生产限流。

查看 trace：

```bash
pnpm exec playwright show-trace tests/e2e/.artifacts/<run-id>/trace.zip
```

## 仍需人工或专项验证的边界

- 与有效原型基线逐页比较相同 1440px 视口，核对布局、字体、菜单和弹窗；功能 E2E 不等于像素一致性验收。
- 多标签页冲突、API/Worker 进程被终止后的恢复，以及失败任务重试/取消，需要独立故障注入或专项用例。
- 中文输入法真实组合输入、复杂字体、导出与编辑像素一致性、性能规模与移动端，不由上述冒烟脚本证明。
- 线上部署、外部云服务、短信/邮件登录和 AI/Sandbox 均不能由本地测试推断已经可用。

最新执行结果将记录在同目录 `verification-results.md`；该文件必须列出实际运行记录，不把未运行项标为通过。
