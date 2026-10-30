# Design-X 系统架构方案（实施版）

版本：v1.0-draft · 日期：2026-10-30 · 状态：**提议稿，待 Milestone 0 验证与决策确认**

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
| 12 | [12-engineering-structure.md](12-engineering-structure.md) | 工程仓库结构（评审稿）：架构到代码的映射、目录树、依赖规则、部署单元、原型过渡 |

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
| `docs/architecture-review.zh-CN.md` | ✅ 已读取（编写 Part 1–11 时尚不存在，之后于 `main` 提交 `e7ef345` 加入） | 内容是 `architecture-review.md` 的中文翻译，没有新增决策，因此不影响 Part 1–11 的结论。 |
| 前端原型源码 `src/**`、`scripts/**`、`package.json` | ✅ 已读取 | `App.jsx`、`AIStudio.jsx`、`Editor.jsx`（结构与导出路径）、`Workbench.jsx`/`Workspace.jsx`/`Catalog.jsx`（函数结构）、`studioModel.js`、`studioSession.js`、`catalog.json`、`templates.js`、检查脚本 |

### 对原型的事实认定（避免把模拟当成能力）

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

本次会话无法直接访问 `tldraw.dev`、`developers.openai.com`、`remotion.dev` 等站点的页面。相关结论来自这些项目在 GitHub 上的官方仓库（LICENSE、README）、npm registry 元数据，以及搜索引擎索引的官方页面摘录，已在引用处注明。

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
