# Design X v2 产品实现与兼容验收

日期：2026-11-08。本文记录仓库中的前端实现及本机浏览器验收，不替代 OpenAI、R2、E2B 的真实供应商验收记录。

## 已实现的工作区行为

- 首页、模板、技能目录、素材库统一创建或进入真实项目。素材库“用于新设计”不再构造本地假项目 ID；模板先进入 Studio，再选择画板精细编辑。
- 服务端能力目录决定模式可用性、图片尺寸、参考图数量、生成数量和配额提示。视频入口在提交前禁用；缺失或未知能力不会默认为可用。
- 图片生成请求与执行 Recipe 分开提交。营销海报、商品套图、多尺寸适配携带配方 ID、版本和结构化参数；其余目录项明确标注为提示词预设。
- 图片是具有 `assetVersionId` 的资产条目，不冒充可编辑文档。“加入可编辑画板”显式创建含图片图层的新 Artboard；Recipe 的文字和品牌元素保留独立图层。
- 多轮续改默认创建新版本；明确选择“应用到原画板”后沿用 Proposal 预览和 revision 校验。
- 生成记录展示图片处理状态、部分产物、受理待核对、再次生成及仅重试摄取。只对明确在后台执行的状态进行快速轮询；未知受理不触发自动重发。
- 项目活动读取真实生成、Agent、版本、Recipe、交互与导出记录。原生问题和控制命令由服务端持久化，刷新后恢复；已提交回答禁用重复提交，停止仍可执行。
- 上传根据存储灰度开关使用签名直传或兼容上传。首页、素材库、Studio、Editor 的素材进入项目时显式关联项目，并保留不可变版本引用。

## 并发与兼容修复

1. 文档 PATCH 成功后立即接受新 revision。项目列表刷新失败只提示读取故障，不把已完成的保存变成失败，也不要求用户重复保存。
2. 图片和 Recipe 产物复用既有三方 Board 合并与历史重定基逻辑。后续拖动、删除、撤销和草稿保留；客户端不会在目标被删后凭空重新追加服务端未放置的结果。
3. 批次接收标识包含已放置产物 ID、素材版本及目标文档 ID。不能使用“总产物数量”，因为等待摄取的输出行可能提前存在，后续完成时总数不变。
4. tldraw 在只读状态忽略新增 shape。提交/上传结束、画布解锁时重新同步领域快照，避免“服务端已创建、画板数量增加、画布却不可见”。
5. 不为每次本地 `board.committed` 事件刷新整个工作区。Recipe 显式合并，生成通过 `generation.updated` 接收，Agent 通过任务事件接收；避免高频画布操作放大素材、能力、会话与活动读取。

主要拆分：`ProjectActivity.jsx`、`RecipeFields.jsx`、`creative-capabilities.js`、`useCreativeActivity.js`。保留现有 UI 风格、tldraw 组织模型、Editor 草稿缓存和 Proposal 面板。

## 自动化验证

| 验证 | 命令 | 本次结果 |
|---|---|---|
| 前端构建 | `pnpm build` | 通过；沿用已有大包提示 |
| 类型检查 | `pnpm exec tsc --noEmit` | 通过 |
| 既有静态/Studio/session 检查 | `pnpm check` | 通过 |
| v2 产品状态及既有 Board 相关单测 | `tsx --test tests/unit/v2-product-state.test.ts tests/unit/ai-board-merge.test.ts tests/unit/ai-request.test.ts tests/unit/board-persistence.test.ts tests/unit/tldraw-adapter.test.ts` | 33 项通过 |
| v2 浏览器产品链路 | `node --import tsx tests/e2e/v2_product.mjs` | 10 项通过 |
| Editor 交互、离线和冲突回归 | `python3 tests/e2e/editor_interactions.py` | 14 项通过 |
| 200 画板虚拟化与并发操作 | `python3 tests/e2e/board_virtualization.py --account-file <private-fixture>` | 13 项通过；测试结束恢复原始夹具 |
| 非 AI 完整创作链路 | `python3 tests/e2e/non_ai_journey.py` | 11 项通过；真实 PNG/PDF 导出和跨租户隔离 |
| 真实 Editor/Renderer 像素一致性 | `node tests/e2e/render_consistency.mjs` | 2 组通过；变化像素比例、平均通道差均为 0 |
| Board 便签、分区、打包、冲突回归 | `python3 tests/e2e/board_features.py` | 18 项通过；真实 `.dxproj`、409 草稿保留和入口交接 |
| 原生 tldraw 手势与兼容开关 | `python3 tests/e2e/tldraw_board.py --account-file <private-fixture>` | 7 项通过；框选、缩放、Alt 拖动、相机和显式 legacy 回退 |

v2 浏览器检查覆盖：不可用模式提前禁用、模板真实项目、Board 自动保存不经 SSE 触发无关资源读取、保存后的列表 503 与继续保存、多尺寸配方、真实活动、素材创建项目、问题与回答/停止的刷新恢复、图片资产与画板区分、移动布局无横向溢出。

浏览器回归合计 75 项/组通过。并行执行时曾触发本地 API 的 600 次/分钟限流，最终按套件顺序完成；没有放宽生产限流。API 状态断言使用 500ms 轮询，避免把浏览器每帧回调用于网络请求。

`v2_product.mjs` 明确使用三类测试数据：一次项目列表 HTTP 503、数据库中的待回答执行、以本地样例图片摄取的生成记录。数据库、对象存储、项目/文档 API 和控制命令均真实执行；该测试不调用模型供应商。报告中的 `fixtures` 与 `liveAiRequests: false` 保留这一区别。

待回答夹具没有 Runner 或队列派发；脚本 `finally` 按本轮创建的 workspace/turn/attempt/session/interaction ID 严格核对，关闭 attempt，并结清未消费的命令。清理前必须确认请求和问题完全匹配、没有 sandbox/thread/model/usage/lease/fence/runtime event，发现真实执行痕迹立即拒绝。收尾核对发现历史 5 次运行遗留此类夹具，已逐个按明确 ID 关闭为 `not_dispatched`；错误 ID 拒绝与重复清理已实测，原有 10 项目、33 文档、33 版本及素材/生成产物均保留。没有为此重跑浏览器或新增模型请求。

兼容测试的模板入口从“直接进入 Editor”更新为“Studio 选择真实画板后进入 Editor”；继续验证相同的编辑、保存、刷新、版本恢复、上传、导出和租户隔离。AI 禁用场景改为断言按钮在提交前禁用，保留草稿且不产生任务。

## 本机验收产物

报告与截图保存在被 Git 忽略的 `tests/e2e/.artifacts/`：

- `v2-product/report.json`、`studio.png`、`mobile.png`。
- `v2-product/fixture-cleanup.json` 记录这 5 条夹具的身份依据、清理后状态及保留数据计数。
- `v2-editor-regression/report.json` 及交互截图/trace。
- `v2-board-scale-regression/report.json` 及虚拟化截图/trace。
- `v2-non-ai-regression/report.json`、PNG/PDF 导出及截图/trace。
- `v2-board-regression/report.json`、`.dxproj` 和冲突草稿。
- `tldraw-20261108-091519/report.json` 与原生手势截图。
- `render-1794158000394/report.json` 及 Editor/Renderer 对照图片。

200 画板账号描述保存在仓库外的权限 `0600` 临时文件中，未将账号密码写入文档、Git 或日志。测试使用专属项目，结束后恢复原始组织与内容。
