# tldraw Board 接入与验收

执行日期：2026-10-31。本阶段将 Board 默认引擎替换为固定版本 tldraw 5.6.0；高仿真外壳、三类业务对象、后端协议和精细编辑器保持原有职责。AI 对话仍保留阶段前的未接入状态，后续 AI UI 独立交付。

## 实际接入边界

- `TldrawBoard.jsx` 使用真正的 `TldrawEditor`、SelectTool、HandTool 和原生选框/尺寸手柄。SDK 执行框选、命中测试、拖动、便签/分区缩放及相机，不是空 SDK 外壳。
- 自定义 `dx-artboard`、`dx-note`、`dx-section` shape 只保存几何、业务 ID 和轻量属性。完整设计仍在业务状态，由共享 `ArtboardRenderer` 渲染。SDK 的 `shape:` ID 和页面坐标相机不会写入服务端 Board 协议。
- `board-state.js` 的组织历史仍是唯一用户可见历史。SDK 在原生手势内暂用内部事务标记，手势结束归一成一个业务命令并清空 SDK 历史；快捷键和工具栏撤销都走业务历史。复制画板仍调用真实创建 API，Alt 拖动只解除吸附，不创建伪文档。
- 分区成员显式加入/移出，移动分区带动成员且去重，删除分区保留内容；全选和撤销覆盖屏外对象。Board 没有旋转字段，因此不显示 SDK 旋转柄；画板预览固定尺寸，只对单个便签或分区显示尺寸柄。
- SDK 空间查询提供视口加 240 px 边缘的候选对象；SDK 保留完整轻量 shape，重预览在屏外真正卸载。活动拖动/输入对象保留挂载，大量进入视口的真实预览分批显示，切换视图取消旧队列。没有用模拟图替代内容。
- 相机在 SDK 内更新，结束或短暂停顿后写回业务状态；保存继续使用轻量 snapshot、串行防抖、ack 和显式 409。精修回流保留最新完整 design。
- 默认使用 tldraw；`/?boardEngine=legacy#studio/项目ID` 显式切回原 BoardWorld，读取同一服务端数据。没有增加新的持久化格式或迁移。

适配层继承 SDK 5.6.0 的 translating/resizing 状态与 selection overlay 内部方法，升级 SDK 时必须重跑原生交互专项。使用已有自托管字体，原生专项记录外部 HTTP 请求为 0。SDK 许可仍遵循 tldraw 自身条款，未移除 SDK 水印。构建主包约 2.36 MB（gzip 716 KB），仍有 Vite 大包提示；拆包不是本阶段完成项。

## 真实回归

所有浏览器检查均使用真实 API 和数据库，没有伪造接口响应。

| 验证 | 结果 | 本机证据 |
|---|---|---|
| 类型检查、SSR/原型检查、Web 构建 | 通过 | `pnpm typecheck`、`pnpm check`、`pnpm build` |
| 相机/ID/轻量 shape 单元测试 | 2/2 | `tests/unit/tldraw-adapter.test.ts` |
| 便签、分区、复制历史、导出、409、首页需求保留 | 18/18 | `tests/e2e/.artifacts/board-20261031-061538-a0a72f/report.json` |
| 200 板全选、屏外成员、删除/撤销、长拖动、取消、精修回流 | 13/13 | `tests/e2e/.artifacts/virtualization-20261031-061606/report.json` |
| SDK 原生框选、尺寸手柄、单步撤销、Alt 拖动、wheel 相机、刷新与显式回退 | 7/7 | `tests/e2e/.artifacts/tldraw-20261031-061531/report.json` |

SDK 专项同时要求无页面错误、HTTP 错误及外部请求。真实尺寸手柄操作后，撤销一次恢复初始宽高，重做一次恢复完整结果；通过实际 UI 和 GET Studio 核对原始业务 ID。

复测命令：

```bash
pnpm check
pnpm test:board
python3 scripts/seed-board-performance.py --account-file /tmp/designx-tldraw-test.json
python3 tests/e2e/tldraw_board.py --account-file /tmp/designx-tldraw-test.json
python3 tests/e2e/board_virtualization.py --account-file /tmp/designx-tldraw-test.json
pnpm build
node tests/perf/serve-production.mjs dist 5181
# 另一个终端：
python3 tests/perf/board_performance.py \
  --account-file /tmp/designx-tldraw-test.json \
  --base-url http://127.0.0.1:5181 \
  --label tldraw-recheck --build-commit YOUR_COMMIT --runs 3 --check-budgets
```

账户描述文件须位于仓库外且权限 0600，不提交凭据。测试结束后清理该文件和专用 preview 进程。

## 生产性能三轮

报告：`tests/perf/.artifacts/tldraw-5.6-final-20261031-061855/report.json`。独立 production preview，无 HMR；1440 × 900、DPR 1、Chromium 156、macOS arm64、本机真实服务，200 画板 × 50 图层、100 便签、20 分区，与前阶段种子规格相同但为新建测试项目。三轮 fixture hash 一致、无超时、页面/HTTP/图片解码错误均 0。

| 指标 | 本轮实测 |
|---|---|
| 初始真实重预览 | 每轮 20 画板、8 便签、4 分区 |
| 初始全页 DOM 元素 | 每轮 3,584 |
| 首个画板就绪中位数 | 408.859 ms |
| 字体与已挂载图片就绪中位数 | 415.663 ms |
| 120 次平移 ScriptDuration / 动作中位数 | 0.783 ms |
| pan RAF p95 | 16.795 / 16.7 / 16.795 ms |
| fit RAF p95 | 16.73 / 16.7 / 16.8 ms |
| 所有采样阶段最大 RAF 间隔 | 每轮 16.8 ms |
| fit 总时长（含固定 1.5 s 观察） | 1.595 / 1.603 / 1.645 s |
| fit 完整性 | 每轮 150 画板 + 70 便签 + 15 分区，target = rendered = 实际 DOM = 235，pending = 0 |
| fit 主线程长任务 | 每轮 0 |
| 原生画布滚动偏移 | scrollTop / scrollLeft 均为 0 |
| 每轮实际保存 | PUT 正文 81,921 B，ack 响应 158 B，无 snapshot |

现有六项预算全部逐轮通过：初始板数 ≤30、DOM ≤5,000、pan RAF p95 ≤20 ms、pan ScriptDuration ≤8 ms/动作、fit 最大长任务 ≤100 ms、fit RAF p95 ≤20 ms。RAF 是调度间隔，不是 GPU 呈现时间；未测 GPU 内存、低端设备、不同大图压力、跨浏览器或多人协作。20% 最低倍率无法把 200 板全部装入当前窗口，150 是视口加预加载边缘的数量，完整项目仍有 200 板。

构建记录为 `9816363-working-tldraw`：当时本阶段改动尚未提交，另含主线程未提交的 App SSE `ai.turn` 事件过滤分支；本轮无 AI 事件，该分支未执行。后端为主线程冻结的固定进程。测试结束后只补了 SSR `typeof window` guard（浏览器路径不变）、SSR 检查断言结束显式退出（SDK 导入保留 idle timer）与文档。因此上述是这次本地集成构建的真实测量，不宣称独立提交产物的字节级复现，也不与旧项目数据做严格 A/B 提速比。

## 修复和证据边界

初期运行遇到三类明确问题并保留原报告：SDK 默认 DOM 顺序导致测试首先定位屏外对象，已改为选实际可见对象且保留业务断言；API watch 重启产生非 JSON 500，冻结服务后重跑，没有放宽 HTTP 检查；复制撤销时 SDK 事务内排序缓存与新对象数量不同，已改为按完整期望顺序生成索引，最终 18 项完整通过。SDK overlay 需要 `getIndicatorPath` 的错误也已修复并通过 7 项原生专项。

原始报告、trace、截图与下载产物被 Git 忽略，以上路径是本机证据。此前 Board 性能基线及其失败诊断保留在 [board-performance.md](board-performance.md)；此文不把之前的 Editor/Import/全系统检查重复算作本轮执行。
