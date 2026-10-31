# Design-X 系统架构方案（实施版）

版本：v1.1-draft · 更新：2026-10-31 · 状态：**用户已确认分阶段实施与 Codex/E2B 路线，其余提议仍按各决策状态验证**

## 当前实施顺序与新增决策（2026-10-31）

已沿用高仿真原型落实个人空间、项目、素材、Board/Artboard、文档保存、异步处理与导出。用户随后授权接入 tldraw 与真实 AI；当前默认 Board 引擎为 tldraw 5.6.0，Agent 入口按服务端 `AI_ENABLED` 开关开放。

最终 AI 执行架构已由用户明确为 **E2B Sandbox 内的 Harness 使用 Codex SDK，模型为 DeepSeek**，替代原稿的自研轻量 Agent loop。API、Worker、Renderer、PostgreSQL、pg-boss、S3 兼容存储及产品拥有的 Creative Document 保持不变。业务权限、任务与成果持久化由控制面负责；当前 Harness 写出文件 manifest，由 Worker 校验并提交，沙箱不能直连数据库。详见 [ADR-0001](../adr/0001-codex-e2b.md) 和 Part 5 §E.4.3。

真实模板、SDK 两轮工具执行与文件回收见 [运行时验证](../implementation/ai-runtime.md)，tldraw 原生交互及 200 画板性能见 [Board 验收](../implementation/tldraw-board.md)，当前产品链路与边界见 [AI 创作实现](../implementation/ai-creation.md)。以下完整 MVP 仍包含未实施的配方、多人协作、图片/视频模型和计费目标，不能当作全部交付；其余原稿的许可与区域假设未因此重新核查。

本目录是 Design-X 的实施导向架构方案，供团队估算、计划、建设和验证使用。正文用简体中文，技术术语、标识符和代码示例保留英文。

## 目录

| 部分 | 文件 | 对应交付物 |
|---|---|---|
| 0 | 本文件 | 阅读说明、证据范围、标注约定 |
| 1 | [01-decisions-and-scope.md](01-decisions-and-scope.md) | A. 执行层架构决策、目标/非目标、MVP 边界 |
| 2 | [02-architecture-diagrams.md](02-architecture-diagrams.md) | B. 九张架构图（上下文、逻辑、前端、后端、AI、异步、部署、信任边界、包依赖） |
| 3 | [03-user-journeys.md](03-user-journeys.md) | C. 八条用户旅程与时序图 |
| 4 | [04-frontend.md](04-frontend.md) | D. 前端架构；§2.2 无限画布 / tldraw 评估 |
| 5 | [05-backend-and-ai.md](05-backend-and-ai.md) | E. 后端与 AI 架构 |
| 6 | [06-infrastructure-selection.md](06-infrastructure-selection.md) | F. 中间件与基础设施选型矩阵（含许可证核验） |
| 7 | [07-data-and-interfaces.md](07-data-and-interfaces.md) | G. 领域模型、ER 图、Creative Document schema、API、事件、状态机 |
| 8 | [08-repository-and-engineering.md](08-repository-and-engineering.md) | H. Monorepo、目录树、依赖方向、契约生成、开发流程 |
| 9 | [09-nfr-and-validation.md](09-nfr-and-validation.md) | I. 非功能需求与验证计划 |
| 10 | [10-roadmap-and-plan.md](10-roadmap-and-plan.md) | J. 路线图、Backlog、团队与排期、迁移步骤、决策日志、风险、待决问题 |
| 11 | [11-sources.md](11-sources.md) | 引用来源与核验状态 |
| 12 | [12-tldraw-adoption-review.md](12-tldraw-adoption-review.md) | AI 创作画布产品研究、tldraw 复评、现有 Board 接入差异与验收阶段 |

建议阅读顺序：决策者读 1 → 10；前端读 1 → 4 → 7 → 3；后端和 AI 读 1 → 5 → 7 → 6 → 3；基础设施读 6 → 2 → 9。

## 证据范围：本方案实际读了什么

| 材料 | 状态 | 说明 |
|---|---|---|
| `docs/美图设计室功能与能力梳理.docx` | ✅ 已完整读取 | 解析了正文 XML。35 个工具、65 个 Skills、编辑器、项目/资产、工作流、“个人作品平台”定位都已读。 |
| `docs/美图式创作平台产品清单.xlsx` | ✅ 已读取 | 6 个工作表：产品全景、产品清单、功能说明、场景配置、入口映射、待确认事项。前三个与“待确认事项”逐行读过；场景配置和入口映射抽样读，并与 DOCX 交叉核对。 |
| `docs/product-research.md` | ✅ 已完整读取 | |
| `docs/design-spec.md` | ✅ 已完整读取 | |
| `docs/verification.md` | ✅ 已完整读取 | 原型的验证与未验收项 |
| `docs/architecture-review.md` | ✅ 已完整读取 | 本会话早前产出的独立评审；这里把它当作“意见”，不当作已批准方案。 |
| `docs/architecture-review.zh-CN.md` | ❌ **文件不存在** | 已检查 `origin/main`、`origin/claude/tender-gauss-t34ry0` 和本地磁盘，都没有这个文件。本方案**没有**参考它的任何内容。 |
| 前端原型源码 `src/**`、`scripts/**`、`package.json` | ✅ 已读取 | `App.jsx`、`AIStudio.jsx`、`Editor.jsx`（结构与导出路径）、`Workbench.jsx`/`Workspace.jsx`/`Catalog.jsx`（函数结构）、`studioModel.js`、`studioSession.js`、`catalog.json`、`templates.js`、检查脚本 |

### 对原型的事实认定（2026-10-30 历史基线）

以下是实施前原型的状态，不是当前系统能力清单。已实现的非 AI 后端与 Board 虚拟化见 [实施性能记录](../implementation/board-performance.md)，本轮代码核对见 [Part 12](12-tldraw-adoption-review.md)。

- 原型是 **React 19 + Vite 6 + 纯 JavaScript**，没有 TypeScript、路由库或状态库，靠 URL hash 导航。
- “AI 生成”是 `src/lib/studioModel.js` 里基于正则和规则的**确定性本地演示**（`source: 'demo-rules'`、`isDemo: true`），没有调用任何模型。视频只产出静态分镜。
- AI 工作区画布 `AIStudio.jsx` 用 DOM 加 CSS `transform: translate/scale` 实现平移缩放。方案以 SVG（文字用 `foreignObject`）预览，可拖动、选择、适应视图，但**没有**多选、吸附、对齐、空间索引和虚拟化。
- 编辑器 `Editor.jsx` 用 DOM 编辑节点（`image | text | rect | circle`），**导出走另一套 Canvas2D 渲染**（`renderDesign`）和 SVG 导出代码。这意味着编辑视图与导出不是同一渲染器，已存在一致性风险。撤销/重做保存最多 80 个整份快照。
- 持久化全部在 `localStorage`（`dx-projects`、`dx-ai-studio` 等），没有后端、账户、云同步和多会话。
- 测试是 Node `assert` 脚本（`npm run check`），覆盖规则模型、会话编解码和页面 SSR 渲染；尚未做真实浏览器验收（见 `verification.md`）。

## 标注约定

| 标记 | 含义 |
|---|---|
| **[已核验]** | 本次已对照官方来源核对（官方仓库 LICENSE 文件、npm 元数据、官方文档或公告），来源见 [11-sources.md](11-sources.md) |
| **[二手]** | 仅有第三方或转载来源，需向厂商确认 |
| **[假设]** | 设计假设或工程判断，必须经 Milestone 0 验证或由决策者确认 |
| **[待定]** | 依赖待决问题（见 10 部分 §J.8） |
| **提议目标** | 性能、质量等阈值都是**提议的验收假设**，不是实测结果 |

2026-10-30 原稿未能直接访问部分厂商页面，相关结论的来源与限制保留于 Part 11。2026-10-31 的 Codex/E2B 更新已实际读取官方文档，新增证据见 Part 11 §11.5；这不表示其他旧结论也已重新核验。

## 关于产品定位的关键冲突（请先读）

原始资料与本次需求在产品定位上不一致：

- DOCX 写明“个人产品的方向是展示产品设计与技术实现能力，**不以商业 SaaS、商品交易或支付为目标**”；XLSX 的 F065 把“会员、点数计费与支付交易”标为“用户明确不纳入”。
- 本次需求描述的是“可扩展的 SaaS 平台”，并要求 billing/quotas、团队协作等模块。

这一冲突直接影响：

1. **tldraw 许可**：非商业可申请 hobby license（带水印），商业生产必须购买商业许可。
2. **Remotion 许可**：个人和不超过 3 名员工的公司可免费使用。
3. **合规工作量**：面向公众的生成式 AI 服务要做“登记/备案”和内容标识。
4. **规模与预算**。

本方案的处理方式是：**架构按“可商业化”标准设计，许可和合规按两条路径给出**；计费（billing）不进 MVP，配额与成本控制（quotas）进 MVP。这是第一个待决问题（Q1）。
