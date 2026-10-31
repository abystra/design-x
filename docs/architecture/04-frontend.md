# Part 4 · 前端架构（交付物 D，含 §2.2 无限画布评估）

> 2026-10-31 非 AI 实施补充：当前保留 React/Vite/CSS 与原型 DOM Board，已实现世界坐标空间 hash、视口/预加载边缘裁剪、局部 RAF 手势和轻量 Board 保存，预览继续复用 `doc-render`。本轮未引入 tldraw/rbush，也未迁移路由或状态库；下表仍是架构推荐，不代表依赖均已落地。200 画板固定负载及实际性能边界见 [Board 性能验证](../implementation/board-performance.md)。

> 2026-10-31 选型复评：以 [Part 12](12-tldraw-adoption-review.md) 为本阶段接入依据。下文 `BoardEngine`、逐项 `BoardOp`、`items/frame/z` 与 `board_views` 仍属目标设计，当前代码尚未实现。建议先兼容现有 `results/notes/sections` 和整包 revision/ack 保存，再在内部开关下验证 tldraw；尚未决定默认迁移。

## D.1 技术栈选择

| 层 | 推荐 | 许可 | 理由 | 备选 |
|---|---|---|---|---|
| 语言 | **TypeScript**（strict） | Apache-2.0 | 文档 schema、ops、API 契约需要类型；原型 JS 渐进迁移（允许 `allowJs`） | 继续使用 JS：不可接受，doc-core 必须是类型化的 |
| 框架 | **React 19**（原型已用；npm 当前为 19.3.x [已核验]） | MIT | 复用原型；tldraw、Moveable 等都是 React 生态 | Vue 3 或 Svelte：要重写原型，且 tldraw 只支持 React |
| 构建 | **Vite**（原型为 6.x，npm 当前为 8.x [已核验]）。M1 开始前升级到当时的稳定主版本 | MIT | 原型已用，开发体验好 | Rspack 或 Next.js：本产品是 SPA 工作台，不需要 SSR/SEO（营销页可单独部署） |
| 路由 | **TanStack Router**（类型安全的路由与搜索参数） | MIT [已核验] | 替代原型的 URL hash 路由；工作区 `/p/:projectId?artboard=` 需要类型化参数 | React Router |
| 服务端缓存 | **TanStack Query** | MIT [已核验] | 项目、素材、任务、会话的请求缓存，SSE 事件驱动失效 | SWR |
| UI 状态 | **Zustand** | MIT [已核验] | 轻量，可在 React 外读写（Board 适配层需要） | Jotai、Redux Toolkit |
| 无障碍组件 | **Radix UI Primitives**（Dialog、Menu、Popover、Tooltip） | MIT [已核验] | 原型手写了 `Modal` 焦点陷阱，统一换成 Radix 获得可靠的焦点与键盘行为 | Ark UI、React Aria |
| 样式 | **保留原型 CSS + CSS 变量 token**，按组件改为 CSS Modules（Vite 原生支持） | — | 原型的视觉系统（`design-spec.md` §5）是资产；不引入新的样式范式 | Tailwind（MIT [已核验]），适合新团队但迁移成本高 |
| 图标 | lucide-react（原型已用） | ISC | 保持不变 | — |
| 变换控件 | **Moveable + Selecto**（daybrush） | MIT [已核验] | Artboard 编辑器的拖拽、缩放、旋转、吸附、多选框选 | 自研 |
| 空间索引 | **rbush** | MIT [已核验] | 自研 Board 保底方案和编辑器命中测试 | flatbush |
| 有序键 | **fractional-indexing** | CC0 [已核验] | 图层与 Board 条目排序，插入无冲突；与 tldraw 的 `index` 语义一致 | 整数 z 值（评审已指出冲突问题） |

## D.2 无限画布（Board）评估与设计（对应需求 §2.2）

### D.2.1 三个概念的严格划分

| 概念 | 是什么 | 谁拥有 | 持久化格式 | 典型数量 |
|---|---|---|---|---|
| **Board** | 项目的无限空间工作区：放置 Artboard、素材、方案组、便签、分区和连线（版本谱系） | 产品（`doc-core` 的 `designx.board` 文档） | `documents(kind=board)` + op-log | 每个项目 1 个（后续可多页） |
| **Artboard** | 可编辑的设计场景：有固定尺寸，内含文字、图片、形状、组合和布局约束；是导出单元 | 产品（`designx.artboard` 文档） | `documents(kind=artboard)` + op-log | 每个 Board 10–500 个 |
| **Creative Document** | 产品拥有的持久真相源，是逻辑聚合：项目清单 + Board 文档 + 全部 Artboard 文档 + 素材引用 + 谱系 | 产品 | 多个 `documents` 行 + `assets`；导出为 `.dxproj` 包 | — |

**tldraw（或任何画布库）的职责只限于 Board 的交互和渲染。** Artboard 的内部编辑由 Design-X 自己的 `artboard-editor` 完成，Board 上的 Artboard 只是一个自定义 shape，用我们的 `doc-render` 绘制内容。理由如下：

1. **导出一致性**：Artboard 必须由服务端导出，与编辑视图一致。如果 Artboard 内容是 tldraw shape，导出就依赖 tldraw 的渲染路径；而 Chromium 导出管线不应依赖受许可约束的 SDK，并且我们需要完全控制字体加载与排版。
2. **排版需求超出 tldraw 默认 shape**：多样式文字 span、竖排、`auto_fit`、字距、品牌 token、约束布局、裁剪和蒙版。tldraw 的富文本基于 TipTap [二手：官方文档摘录]，可以扩展，但会把我们的核心数据模型绑在它的 shape 体系上。
3. **数据主权**：Artboard 是产品的核心资产（原则 AD-01），不能是第三方 SDK 的内部格式。
4. **规模**：每个 Artboard 有 10–200 个节点；如果都作为 tldraw shape，一个 Board 会有上万个 shape，Board 层的选择和吸附语义也会混乱。

### D.2.2 tldraw 事实核验

| 事项 | 结论 | 来源/状态 |
|---|---|---|
| 当前版本 | `tldraw`、`@tldraw/editor`、`@tldraw/sync`、`@tldraw/sync-core` 都是 **5.6.0** | npm registry [已核验] |
| 许可类型 | **tldraw license（source-available，非 OSI 开源）**。npm `license` 字段为 `SEE LICENSE IN LICENSE.md`；`@tldraw/tlschema` 为 MIT | GitHub `LICENSE.md` + npm [已核验] |
| 开发环境 | 允许在“不对终端用户或公众开放的内部开发、测试、预发环境”使用 | LICENSE.md 原文 [已核验] |
| 生产环境 | **未获试用或商业协议时禁止生产使用**；生产环境包括“向终端用户、客户或公众提供功能”的任何部署 | LICENSE.md 原文 [已核验] |
| 许可证密钥 | 生产必须有有效密钥；不得禁用或绕过密钥校验；软件会检测部署环境并强制显示水印；“可能为合规目的收集并传输使用数据” | LICENSE.md 原文 [已核验] |
| 密钥校验方式 | 官方文档称密钥在本地解码校验，不访问许可服务器；密钥可放在前端代码中；按域名绑定 | 搜索引擎索引的 tldraw.dev 文档 [二手] |
| 分发限制 | 不得作为独立产品分发，只能作为其他应用的一部分 | LICENSE.md [已核验] |
| 试用 | 100 天试用，每个业务单元一次 | LICENSE.md（“一次试用”）[已核验]；“100 天”来自官方页面摘录 [二手] |
| Hobby 许可 | 面向非商业项目，需申请，**保留“made with tldraw”水印** | 官方页面摘录 [二手] |
| 商业价格 | **官方未公开金额**，年度许可按价值询价；不采用第三方价格传闻估算预算 | [官方定价，2026-10-31 重新读取](https://tldraw.dev/pricing) |
| 协作（sync） | `@tldraw/sync` 同样采用 tldraw license；官方称已购商业许可者使用 sync 不额外收费；可自托管，官方模板基于 Cloudflare Durable Objects，也提供 Node/Bun 通用服务端模板 | npm [已核验]；收费与模板说明 [二手] |
| 内部工具 | 官方 FAQ 称公司内部产品也算商业用途 | [二手] |
| 区域 | 许可条款未见地域限制；Cloudflare Durable Objects 在中国大陆的可用性**未核实**，自托管 sync 应走 Node 模板 | [待定] |

**结论**：tldraw **不能**被描述为宽松开源。若 Design-X 是商业产品，生产上线必须购买商业许可（价格未知，需纳入预算决策）；若是非商业的个人作品，可申请 hobby 许可，但必须接受水印。

### D.2.3 方案比较

候选方案：

- **T**：tldraw（Board）+ 自研 Artboard 编辑器
- **D**：自研 DOM Board，在原型基础上演进，使用 rbush、Moveable、Selecto 等 MIT 库，与 Artboard 共用 `doc-render`
- **L**：Leafer UI（MIT [已核验]，Canvas 引擎，带编辑器插件）做 Board
- **K**：Konva（MIT [已核验]）做 Board
- **E**：Excalidraw（MIT [已核验]）

| 维度 | T：tldraw | D：自研 DOM Board | L：Leafer | K：Konva | E：Excalidraw |
|---|---|---|---|---|---|
| 平移缩放、视口 | ✅ 成熟（相机、惯性、触控板手势） | 原型已有基础，需补手势、惯性和缩放到选区 | ✅ | ✅（需自写交互） | ✅ |
| 选择、多选、框选 | ✅ | Selecto + 自写选择模型 | ✅ 编辑器插件 | 需自写 | ✅ |
| 拖拽、组合 | ✅ | Moveable | ✅ | Transformer | ✅ |
| 吸附、对齐、分布 | ✅ 内置吸附与对齐工具 | Moveable 吸附线 + 自写对齐 | 部分（插件） | 需自写 | 基础 |
| 自定义 shape（Artboard 卡片、素材、方案组、AI 操作按钮） | ✅ `ShapeUtil` + `HTMLContainer`，可渲染任意 React DOM [二手：官方示例] | ✅ 本来就是 React 组件 | Canvas 元素，嵌 DOM 较麻烦 | Canvas 节点 | 弱：元素类型固定，仅有 embeddable |
| Board 内高保真 Artboard 显示 | 用 `HTMLContainer` 挂 `doc-render` 或缩略图 | 直接挂 `doc-render` | 只能用位图缩略图（DOM 渲染器无法放进 Canvas） | 只能用位图 | 位图 |
| CJK 文字、输入法（Board 便签和标题） | TipTap / contenteditable，原生输入法 [假设：M0 验证中文输入法] | 原生 contenteditable | Canvas 文本，输入法需借助隐藏 textarea | 同左 | textarea 叠加，可用 |
| 无障碍 | 有键盘导航与屏幕阅读器支持 [二手] | 自写 | 弱 | 弱 | 中 |
| 撤销/重做、剪贴板、快捷键 | ✅ 完整 | 自写（可复用 doc-core inverse ops） | 部分 | 自写 | ✅ |
| 持久化 | 自有 store 快照；我们做适配层映射 | 直接就是 doc-core | 需映射 | 需映射 | 需映射 |
| 性能：多 Artboard、大图 | 内置空间索引和 culling 隐藏 DOM；自定义预览仍需卸载/LOD，详见 Part 12 | 已实现空间 hash、卸载与分帧挂载；更复杂素材和 LOD 继续验证 | Canvas 渲染数量上限高 | 高 | 中 |
| 缩略图 | 我们自己的 render.thumbnail | 同左 | 同左 | 同左 | 同左 |
| 协作 | `@tldraw/sync`（同许可）或自写 | 自写（Yjs 或服务端 ops） | 自写 | 自写 | 有协作方案（需自写后端） |
| 导出与一致性 | Board 暂无独立像素导出；`.dxproj` 包含 Board，Artboard 像素导出走自有 Renderer | 同左 | 同左 | 同左 | 同左 |
| 数据所有权与可移植性 | 适配层后由我们拥有 | 完全拥有 | 拥有 | 拥有 | 拥有 |
| 许可与成本 | **Source-available；商业生产需付费；hobby 有水印** | 全部 MIT/CC0，零许可成本 | MIT | MIT | MIT |
| 扩展性 | 强（工具、UI 覆盖、绑定） | 完全可控 | 中 | 中 | 弱 |
| 维护与锁定 | 依赖供应商版本与许可变化；**适配层可降低锁定** | 维护成本最高 | 社区规模较小（中国开发者主导）[假设] | 成熟，但交互全部自写 | 产品形态绑定白板 |
| 当前迁移工作量 | 需经真实项目适配试验估算 | 已有实现与 200 板测试，按缺失能力估算增量 | 未复评 | 未复评 | 未复评 |

> 原稿周数估计早于当前非 AI 实现，已撤下。候选能力比较不代表均已在本项目验证。

### D.2.4 推荐

**推荐：方案 T（tldraw Board）作为首选，方案 D（自研 DOM Board）作为保底，两者都实现 `BoardEngine` 接口。**

- 优先验证 T 的理由：Board 是一等能力，成熟的选择、吸附、工具状态机和扩展机制可能降低后续维护成本。是否优于现有实现需比较真实交互与集成成本，不能预先承诺工期压缩或性能提升。
- 选 T 的前提（M0 go/no-go）：
  1. 许可可接受：商业报价进入预算，或项目确认非商业并接受 hobby 水印（Q1、Q5）。
  2. 中文输入法和 CJK 在 Board 文字（便签、方案组标题）中表现正确。
  3. 复用现有 200 板 × 50 图层、100 便签、20 分区的固定负载和六项预算，并增加不同私有素材、全选与低倍率完整总览测试；具体口径见 Part 12。
  4. 抓包确认无未披露的外呼；若有，评估合规影响。
- 任一前提不满足则继续使用 D。保持现有语义时可以争取兼容旧数据；新增层级、缩放或绑定等语义仍需 schema 和项目包迁移。当前尚无已实现的适配层，不能承诺只换组件或零迁移。

### D.2.5 tldraw 集成边界（方案 T 的具体设计）

**(1) 自定义 shape 映射**

下表包含后续目标能力。首期仅兼容现有画板、便签和分区，Artboard 保持当前显示尺寸；展示缩放、素材节点、谱系和生成状态按 Part 12 的分阶段方案另行实现。

| Board 条目 `kind` | tldraw shape type | 渲染 | 交互 |
|---|---|---|---|
| `artboard_ref` | `dx-artboard`（基于 `BaseBoxShapeUtil`） | 目标 LOD：缩放 < 0.35 显示缩略图 `<img>`；0.35–1.5 显示 `doc-render` 只读 DOM；> 1.5 时 DOM 加高分辨率图片；阈值需实测 | 双击进入编辑器；首期固定显示尺寸、禁止旋转；后续 schema 支持后可开放等比展示缩放，不改作品尺寸。AI 操作另属后续阶段 |
| `asset` | `dx-asset` | 缩略图或预览渲染副本 | 拖入 Artboard（drop 到编辑器）、`@` 引用到对话 |
| `result_group` | `dx-result-group`（类似 frame 的容器） | 标题、状态（生成中 2/4）、回合链接 | 整组移动；点标题定位到对话回合 |
| `note` | 首期 `dx-note` | 保留纯文本、颜色与宽高 | 可编辑文字；采用原生富文本需另做格式兼容 |
| `section` | 首期平面 `dx-section` | 保留显式成员和绝对坐标 | 删除分区保留成员；不能直接套用内置 frame 的父子与裁剪语义 |
| `lineage` | `arrow` + binding（只读，系统生成） | V1 → V2 连线 | 不可手动编辑 |
| `placeholder` | `dx-placeholder` | 生成中或失败卡片 | 重试、取消 |

**(2) 序列化与同步**（目标设计；当前先兼容 snapshot API，见 Part 12）

```ts
// packages/board/src/BoardEngine.ts（接口示意）
export interface BoardEngine {
  mount(el: HTMLElement, doc: BoardDoc, opts: BoardOptions): void;
  applyRemote(ops: BoardOp[], origin: OpOrigin): void;     // 服务端或 AI 来的变更，不进入本地撤销栈
  onLocalOps(cb: (ops: BoardOp[]) => void): Unsubscribe;    // 用户交互产生的变更
  getSelection(): BoardItemId[];
  onSelectionChange(cb: (ids: BoardItemId[]) => void): Unsubscribe;
  setCamera(c: Camera): void;
  getCamera(): Camera;
  zoomToItems(ids: BoardItemId[]): void;
  screenToBoard(p: Point): Point;
  boardToScreen(p: Point): Point;
  dispose(): void;
}
```

- **本地 → 文档**：监听 tldraw store 中来源为用户、范围为文档的变更（`editor.store.listen(..., { source: 'user', scope: 'document' })`），目标是投影为业务变更；当前首期仍保存自有 Board snapshot。提交边界必须覆盖拖动、键盘、粘贴、菜单和撤销，不能只依赖 pointer up。后续逐项 `BoardOp` 是单独的数据协议演进。
- **文档 → 本地**：远端变更在异步取数完成后通过 `editor.store.mergeRemoteChanges(() => ...)` 同步应用，基本写入不进入本地历史；自定义 side effect 的衍生写入、异步越界及回环须专项验证，详见 Part 12。
- **不持久化** tldraw 的 `instance`、`camera`、`pointer` 等会话记录；视口单独写入 `board_views`（按用户）。
- 映射规则：`shape.id = "shape:" + item.id`；`shape.index = item.z`（都是分数索引字符串）；`shape.props` 只放渲染所需的字段，例如 `artboard_id`、`thumb_asset`、`w`、`h`，**不放 Artboard 内容**。
- **版本锁定**：tldraw 版本固定，升级时跑映射层契约测试（Part 9）。

> 2026-10-31 已查阅官方 shape、store、history 文档与相关主线源码；这不等于锁定发行版的接入验证。映射契约、当前模型差异和来源见 Part 12。

**(3) 坐标转换**

- Board 坐标（board px）等于 tldraw page 坐标，1:1。
- Artboard 条目：`frame = {x, y, w, h}`（board 坐标）；Artboard 内容尺寸为 `size = {w, h}`（设计 px）；显示比例 `s = frame.w / size.w`，强制 `frame.h = size.h * s`。
- 换算：`artboardPoint = ((p.x - frame.x) / s, (p.y - frame.y) / s)`；反向为 `boardPoint = (frame.x + a.x * s, frame.y + a.y * s)`。MVP 禁止 Artboard 在 Board 上旋转，以保持换算简单。
- 拖素材到 Artboard 时，把 drop 点从屏幕坐标转为 board 坐标（`screenToBoard`），再转为 artboard 坐标，最后生成 `insert` op。

**(4) 选择与事件边界**

| 事件 | Board 层处理 | 编辑器层处理 |
|---|---|---|
| 单击或框选 | tldraw 选择 → `onSelectionChange` 写入 Zustand `boardSelection` | — |
| 双击 `dx-artboard` | 拦截，打开编辑器聚焦模式（路由参数 `?artboard=ab_7`），Board 进入只读 | 挂载 ArtboardEditor，接管键盘 |
| 键盘 | 编辑器关闭时由 tldraw 处理快捷键 | 编辑器打开时由编辑器处理；Esc 返回 Board |
| AI 对话“引用选中项” | 读取 `boardSelection`（Artboard 或素材） | 读取 `editorSelection`（节点 id） |
| 粘贴 | tldraw 粘贴 → 我们的粘贴处理器：图片文件先走上传流程，再插入 `asset` 条目 | 编辑器粘贴：文字或图片节点 |

**(5) 撤销边界**

- Board 交互：使用 tldraw 的 history（用户本地操作）。每个撤销或重做都会产生新的 `BoardOp` 提交到服务端（撤销本身也是一次新提交，服务端没有“回滚”概念）。
- Artboard 编辑：使用 `artboard-editor` 的 inverse-op 栈。
- AI 修改：不进入任何本地撤销栈，通过“撤销本次 AI 修改”按钮（服务端反向操作）撤回。

### D.2.6 若 tldraw 许可不可接受：保底与迁移路径

1. **从第一天起只依赖 `BoardEngine` 接口**；业务代码禁止 `import 'tldraw'`，只有 `packages/board/src/tldraw/*` 可以引用（dependency-cruiser 规则）。
2. **DomBoardAdapter（方案 D）** 在原型 `AIStudio.jsx` 画布的基础上实现：
   - 世界层：`transform: translate3d + scale`（已有）；
   - 空间索引：rbush，用于视口剔除和命中测试；
   - 选择、框选：Selecto；变换：Moveable，带吸附与对齐参考线；
   - 撤销：doc-core inverse ops（与编辑器同一机制）；
   - LOD：与 T 方案同一套规则（缩略图 → `doc-render`）。
3. **复用现有 DOM 实现作为对照**，在特性开关下完成 tldraw 最小真实链路，用同一套 200 Artboard 数据比较交互、DOM、帧间隔和内存，并验证中文输入法。
4. 如果上线后才切换：先验证自有格式到目标引擎的往返映射。涉及新对象、层级或显示几何时显式迁移 schema 与项目包；不能仅凭数据格式自有就承诺零迁移。保持完整业务回归，见 Part 12。

## D.3 Artboard 编辑器

| 方面 | 设计 |
|---|---|
| 渲染 | `doc-render` 的 `<ArtboardRenderer doc mode="edit">`：每个节点一个绝对定位元素；文字用 `<div>` 加 CSS（`white-space: pre-wrap`、`line-break: strict`、`word-break: normal`、`writing-mode`）；图片用 `<img>` 或 `<div style="background">`，`object-fit` 与 crop 换算；形状用 `<svg>` |
| 变换 | Moveable 处理拖拽、缩放、旋转，**吸附到画板边缘、中心、其他节点和参考线**；Selecto 处理框选和 Shift 多选 |
| 文字编辑 | 双击 text 节点进入 `contenteditable`（plaintext-only 模式加自管样式 span）；`compositionstart` 到 `compositionend` 期间不提交 op；`auto_fit=shrink` 在 `compositionend` 后测量并调整字号 |
| 图层与属性面板 | 原型右侧面板升级：节点树（组合、锁定、隐藏）、样式、约束、`role`（AI 语义角色）、品牌 token |
| 约束布局 | `constraints.h/v`（left、right、center、stretch、scale）。`resize_artboard` 时由 doc-core 计算新的 transform，客户端和服务端结果一致 |
| 模板 slot | 模板节点带 `slot_id` 与 `role`；替换素材或文案时保持 slot 布局 |
| 撤销 | inverse-op 栈，每个文档最多 200 步。拖拽在 pointer up 时合并；打字在 500ms 空闲或 compositionend 时合并 |
| 性能目标（提议） | 150 节点 Artboard 拖拽 ≥ 50 fps；单节点属性修改到画面更新 < 16ms |

## D.4 状态分层

| 状态类型 | 存放位置 | 生命周期 | 例子 | 同步方式 |
|---|---|---|---|---|
| UI 状态 | Zustand `uiStore` | 内存、会话级（部分存 localStorage，如面板宽度） | 选中项、打开的面板、当前工具、编辑器是否打开、移动端视图切换 | 不同步 |
| 视口 | Zustand + 服务端 `board_views` | 按用户持久化 | camera x/y/zoom | 2s 防抖 PUT |
| **文档状态** | `DocStore`（每个文档：`head` 已确认的版本 + `pending` 本地待提交 ops + `optimistic` 视图） | 持久，以服务端为准 | Board 条目、Artboard 节点 | ops API + SSE `document.committed` |
| 服务端缓存 | TanStack Query | 可失效 | 项目列表、素材列表、任务、对话消息 | REST + SSE 驱动的 `invalidate` 或 `setQueryData` |
| 离线缓存 | IndexedDB | 跨会话 | 最近打开文档的快照、待提交 ops 队列、事件游标 | 启动时对账 |
| AI 流式输出 | Zustand `aiStore`（按 turn_id） | 回合内 | 消息增量、步骤进度 | SSE `ai.message.delta` |

**原则**：组件不直接 `fetch`；文档只能通过 `DocStore.apply(ops)` 修改；UI 状态里不能有业务数据的唯一副本（原型的 `results` state 把业务数据放在组件状态里，这一点需要改）。

## D.5 文档操作、撤销、自动保存、离线与重连

```text
用户交互 ──► doc-core.apply(op) ──► optimistic 视图更新（同步）
                     │
                     ├─► inverse op 入本地撤销栈
                     └─► pending 队列（内存 + IndexedDB）
                                │（合并：pointerup、500ms 空闲、compositionend）
                                ▼
          POST /v1/documents/{id}/ops {base_revision, client_op_id, ops}
                ├─ 200：head = 返回的 revision；pending 移除
                ├─ 409：拉取 ops?since=base，在本地重新基于新 head 应用 pending（rebase）；
                │       仍冲突则进入冲突 UI（保留我的 / 使用最新）
                └─ 网络错误：指数退避重试（1s→30s），状态栏显示“离线，N 项待同步”
SSE document.committed（其他来源）──► 如果 revision == head+1 就直接应用；有缺口就拉取 ops?since=head
```

- **离线**：允许继续编辑已打开的文档。生成和导出等需要服务端的操作会禁用，并提示“联网后可用”。
- **重连**：SSE 自动重连并携带 `Last-Event-ID`；服务端从 outbox 补发（保留 24h）；游标过旧则让客户端做全量 bootstrap。
- **多标签页**：用 `BroadcastChannel` 协调，只让一个标签页负责发送 pending 队列，避免重复提交（`client_op_id` 也能兜底去重）。

## D.6 字体、CJK、输入法、性能、素材渲染与导出一致性

### D.6.1 字体

- **字体注册表**（服务端 `fonts` 表，Part 7）：`font_id`、family、weights、`license`（OFL 或商业授权编号）、`allowed_uses`（web_embed、server_render、export_embed）、文件位置。
- **MVP 字体集合**（全部 OFL-1.1）：思源黑体（Source Han Sans）、思源宋体、霞鹜文楷（LXGW WenKai）[已核验 OFL]，另加 3–5 款拉丁字体。商业字库（方正、汉仪等）**不进 MVP**，需要单独签授权，且授权要覆盖 Web 嵌入和服务端渲染导出。
- **分片加载**：CJK 字体按 `unicode-range` 切成约 100 个 woff2 分片（构建时用 fonttools 生成，MIT [已核验]），浏览器只下载用到的字。服务端 Renderer 使用**同一批分片文件**和同一份 `@font-face` CSS，从而保证一致。
- 文档里引用字体用 `font_ref` 加 weight，不用系统字体名。原型使用 `"PingFang SC", "Microsoft YaHei"`，依赖系统字体，导出结果会因机器不同而不同，必须改掉。

### D.6.2 CJK 与输入法

- 文字节点：`lang="zh-CN"`、`line-break: strict`（避头尾）、`text-autospace`（浏览器支持时）。竖排用 `writing-mode: vertical-rl`。
- 所有文本输入点（对话框、便签、文字节点、属性面板）统一处理 `isComposing`。原型对话框已经做了（`!e.nativeEvent.isComposing`），要推广到编辑器快捷键：组合输入期间禁用 Enter、Esc、Delete 等快捷键。
- 测试矩阵：Chrome、Edge、Safari 最新版 × macOS 拼音、Windows 微软拼音、搜狗输入法 [假设：M0 验证]。

### D.6.3 性能与素材渲染

- 每个素材在 ingest 时生成渲染副本：`thumb_256`、`preview_1024`、`display_2048`（WebP）。原图只在导出和放大到 > 1.5x 时使用。
- Board LOD：缩略图 → DOM（只读 `doc-render`）→ 高分辨率素材。视口外的 shape 剔除；同时挂载的 DOM Artboard 不超过 30 个（提议），超出部分用缩略图。
- 大图：解码用 `img.decode()` 异步进行；超过 8K 像素的图片只在编辑器中使用 `display_2048`，导出时由服务端读原图。

### D.6.4 导出一致性

- 浏览器内**不做**最终导出（原型的 Canvas2D `renderDesign` 将被移除）；“快速预览下载”也走服务端 Renderer。
- Renderer 用 Chromium 打开内部路由 `/render?doc=&rev=&token=`，加载 `doc-render` 的 export 模式（隐藏编辑控件），等待 `document.fonts.ready` 和所有图片 `decode()`，然后 `page.screenshot({clip, omitBackground})`（PNG 支持透明）。PDF 用 `page.pdf()` 输出矢量 PDF。CMYK 和印刷 PDF 不在 MVP 范围。
- 一致性测试：50 份参考文档的“浏览器截图 vs Renderer 输出”做 SSIM 比较（Part 9）。

## D.7 可访问性与响应式

- 键盘：Board 和编辑器都有完整的快捷键表，所有操作都有按钮入口；焦点可见。
- 屏幕阅读器：Board 条目和 Artboard 节点提供 `aria-label`（名称、类型、位置）；对话流使用 `aria-live="polite"`（原型已有）。
- 动效遵循 `prefers-reduced-motion`（原型局部已有，需推广）。
- 响应式：桌面优先（≥ 1024px 完整工作区）；平板可查看 Board、对话和简单编辑；手机保留原型的“对话 / 画布”底部切换，只支持查看、对话和导出，不支持精细编辑。

## D.8 从原型迁移的路径

| 原型模块 | 处理 | 目标位置 | 说明 |
|---|---|---|---|
| `App.jsx` 外壳、导航、首页、模板页 | **复用 + 重构** | `apps/web/src/routes/*` | hash 路由改为 TanStack Router；localStorage 数据改为 API |
| `AIStudio.jsx` 对话区 | **复用 UI，换数据层** | `apps/web/src/features/chat` | 消息来自 `ai_messages` 和 SSE；三阶段假进度改为真实步骤；“演示”标注移除 |
| `AIStudio.jsx` 画布区 | **替换为 BoardEngine**（T 方案）或**演进为 DomBoardAdapter**（D 方案） | `packages/board` | 平移缩放、fit、zoomBy 逻辑可移植到 D 方案 |
| `DesignPreview`（SVG + foreignObject） | **替换** | `packages/doc-render` | 统一渲染器 |
| `Editor.jsx` | **重构** | `packages/artboard-editor` | 节点 UI 与属性面板可复用；快照式撤销改为 ops；Canvas2D 导出删除 |
| `Workbench.jsx` 技能表单 | **复用 UI** | `apps/web/src/features/skills` | 提交改为 `POST /v1/recipes/{id}/runs`；`setInterval` 演示状态改为真实任务 |
| `Workspace.jsx` 项目、资产、品牌 | **复用 UI，换数据层** | `apps/web/src/features/{projects,assets,brand}` | localStorage 改为 API |
| `Catalog.jsx` + `catalog.json` | **复用** | `packages/recipes/catalog` | 每个技能新增 `implementation: recipe_id or "agent_generic" or "unavailable"` 字段，未实现的技能如实标注 |
| `studioModel.js` | **保留为离线 demo 与测试夹具**；生产中**不使用** | `packages/testing/fixtures/demo-rules` | 作为 E2E 测试的确定性“假供应商”（`provider=fake`） |
| `studioSession.js` | **退役** | — | 会话持久化改为服务端 |
| `templates.js` | **迁移为模板文档** | `packages/recipes/templates/*.json` | 转换为 Artboard v1 加 slot 标注 |
| `scripts/check-*.mjs` | **迁移为 Vitest** | 各包 `*.test.ts` | 断言保留 |
| `public/assets/*.jpg` | 保留为示例素材 | `apps/web/public/samples` | 来源已记录在 `design-spec.md` |
| CSS 与视觉 token | **复用** | `packages/ui/tokens.css` + CSS Modules | — |
