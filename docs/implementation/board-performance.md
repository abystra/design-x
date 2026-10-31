# Board 空间虚拟化与性能验证

执行日期：2026-10-31。本轮使用真实本地 API/PostgreSQL 的 200 画板项目；AI 未接入。旧版基线3轮、最终优化版3轮均已完成，最终每轮通过六项明确性能预算；200画板功能专项13项通过。结论限于下述本机固定负载，完整系统回归见总验证记录。

## 固定负载与环境

基线代码为 `7c33566`，使用独立 production build，不读取正在热更新的开发页面。环境为 Apple M1、16 GiB 内存、8 个逻辑 CPU、macOS 26.6.2 arm64、Node 22.22.3、pnpm 10.20.0、Python 3.14.0、Vite 6.4.5。Python Playwright 使用本机 Node Playwright 安装的 Chromium **156.0.8078.4**；headless、1440 × 900、DPR 1，无 CPU 节流。

[种子脚本](../../scripts/seed-board-performance.py)通过真实注册、项目/画板创建、Board 保存 API 建立专用隔离测试账户和项目：

- 200 个 Artboard，每个 50 图层，共 10,000 图层，含中文文字、矩形/圆形和图片。
- 400 × 300 文档，10 列 × 20 行，画板坐标间隔 380 × 360；100 个便签、20 个分区，各分区包含对应一行的 10 个画板和 5 个便签。
- 每板 5 个图片图层，共用真实同源 `/assets/coffee.jpg`；这不是 1,000 张不同素材的下载压力测试，也不涵盖私有上传资源的性能。
- 初始视图 `{x:60,y:110,zoom:0.75}`，无选中项。每轮测量前通过 API 恢复相同 view/selection，不改变内容或几何。
- 旧版和新版复用同一项目。基线后、功能回归前归档了结果 ID/位置/文档、便签和分区；SHA256 为 `4d137df0d20409ae3505521c9ce49da5ec6cc2766fe1f99b02e8ba86ca155397`。后续测量先核对这一摘要，避免把删减或移动后的数据误作优化效果。基线三轮早于此摘要校验代码，原报告不含该字段。

本机原始报告、构建和截图位于 `tests/perf/.artifacts/`，被 Git 忽略。凭据只保存于仓库外权限0600的临时文件，不写入报告；本次复验结束后已删除 `/tmp/designx-perf-200-50.json`，测量专用5175 preview也已停止。后续复现需重新seed专用账户，再在同一新fixture上比较前后版本。脚本创建的项目是测试数据，清理由执行者在不再需要复验时另行处理。

## 可复现命令与测量方法

先按项目 README 启动真实 API、PostgreSQL 等服务，再使用新的临时文件路径创建 fixture。已存在的凭据文件不会被覆盖。

```sh
python3 scripts/seed-board-performance.py --account-file /tmp/designx-perf-200-50.json
pnpm exec vite build --outDir tests/perf/.artifacts/build-baseline-7c33566
node tests/perf/serve-production.mjs tests/perf/.artifacts/build-baseline-7c33566 5175
```

另一个终端运行：

```sh
python3 tests/perf/board_performance.py \
  --account-file /tmp/designx-perf-200-50.json \
  --label baseline-200x50-valid --build-commit 7c33566 \
  --runs 3 --deadline 180
python3 tests/perf/summarize_board.py tests/perf/.artifacts/<运行目录>/report.json
```

优化后使用相同流程构建到另一目录，停止本测量专用 preview 后在相同 5175 端口启动新目录，再以新 label/build-commit 运行同一脚本。不要重建或改动 fixture，也不要与其他压测同时运行。`--build-commit` 是报告标签，执行者必须核实构建所用代码；脚本不会自动检出该提交。

[测量专用 preview](../../tests/perf/serve-production.mjs)仅监听 127.0.0.1，将 `/api` 代理到 3001。因本地 API 配置的允许来源为 5173，代理将 Origin 设为该既有来源；这是测试入口的适配，不修改产品来源校验。可用 `DESIGNX_PERF_API_ORIGIN` / `DESIGNX_PERF_WEB_ORIGIN` 对齐其他本地端口。无 API 成功响应 mock。

[浏览器脚本](../../tests/perf/board_performance.py)每轮启动新浏览器，真实 UI 登录，恢复视图，清除并禁用浏览器网络缓存后整页进入 Studio。登录前的 `/auth/me` 401 单列为 setup 响应，不计为测量业务失败。每个子进程有 180 秒硬截止；超时保留已采样数据，不无限等待渲染器。

| 阶段 | 操作与记录 |
|---|---|
| 加载 | 导航到第一个画板 DOM 出现；随后等待字体、已挂载 BoardWorld 图片及实际可见 UI 图 decode；记录时间、实际挂载数、全页元素数、资源/请求、CDP DOM 和性能指标、长任务 |
| idle | 关闭默认技能面板，选手形工具，等待 500 ms 后采样 2 秒 |
| pan | 在无控件的画布空白处按下，沿固定圆形轨迹发送 120 个真实鼠标 move；目标间隔 1/60 秒；采样中验证 world transform 已变化；记录实际耗时 |
| zoom | 点击放大 10 次、缩小 10 次，每次固定等待 60 ms |
| fit-all | 点击“适应所有方案”，等待 1.5 秒；优化后还必须满足挂载队列清空、目标数=已渲染数=实际三类 DOM 总数，额外等待计入耗时，完成后截图 |

每阶段采集 RAF 间隔 p50/p95/最大值与超过 33.34/50 ms 次数、主线程长任务（≥50 ms）、CDP Script/Layout/RecalcStyle/TaskDuration 差值、LayoutCount、JSHeapUsedSize、请求数和挂载元素数。摘要按三轮各指标的中位数汇总；最大帧间隔保留所有轮中的最大值。原报告保留各轮，不能把“中位 p95”当成合并后总体 p95。

优化后增加 `--check-budgets`，每轮将预算和实测值写入报告，任一超限、测量失败、进程异常退出或超时均返回失败。固定 200 × 50、1440 × 900、DPR 1 的本地六项门槛为：初始挂载 Artboard ≤30、全页元素 ≤5,000、pan RAF p95 ≤20 ms、pan ScriptDuration/120 ≤8 ms/动作、fit-all 最大长任务 ≤100 ms、fit-all RAF p95 ≤20 ms。RAF 门槛是 50 fps 调度代理，不能解释为 GPU 显示帧率保证。基线不启用预算，保留旧行为；不能仅以无页面错误作为性能通过依据。

新脚本在所有计时阶段结束后读取浏览器实际 PUT Studio 的请求正文字节、响应解码字节、Playwright 网络尺寸及 ack/snapshot 形态；不在手势过程中读取响应正文，也不把 API 独立基准的响应体大小代入浏览器证据。LongTask 按 observer 回调时的阶段归类，边界任务可能跨段，因此阶段计数 0 也不代表绝对无卡顿。

鼠标/按钮派发、自动等待及采样本身有开销，120 次输入在旧版实际超过目标 2 秒；这是受控驱动下同样工作量的耗时，不是直接测得的手指到屏幕延迟。RAF 时间戳不是 GPU 实际呈现时间；未强制 GC，heap 是采样瞬间的存活估计，不能当作峰值或单独作为内存降幅结论。字体/图片 ready 只覆盖当时挂载节点；虚拟化后的“可见画板可操作”与旧版“全部 DOM 已挂载”需要连同实际挂载数一起解读。

图片 ready 口径有一次明确修正：旧基线等待全部 `document.images`；新版修正原生滚动后，三个技能卡 lazy 图在视口下方（y=995）不再触发加载，等待全部 decode 会超时。诊断确认字体和 Board 图片均正常，未完成者仅为两个 headphones.jpg、一个 skincare.jpg。因此当前脚本等待所有已挂载 BoardWorld 图片，加上经过祖先裁剪判断确实可见的 UI 图，排除列表/坐标保留在报告。没有将业务图片改成 eager 来配合测试。前后主加载比较使用口径未变的 `boardDomReadyMs`；`fontsImagesReadyMs` 仅作各自观察值，不宣称其变化是同口径加速。

旧驱动对 decode 失败作 settled 处理；最终驱动另记录 `decodeErrors`，任一待测图片解码失败均使本轮失败，避免 HTTP 200 的坏图被算作 ready。fit 的额外完成等待按实际值披露；若等待变长，不能将更长空闲尾部稀释后的 p95 描述为交互更快。

## 旧版基线：已完成 3/3

[三轮报告](../../tests/perf/.artifacts/baseline-200x50-valid-20261031-041049/report.json)，运行 ID `baseline-200x50-valid-20261031-041049`。三轮均通过，无测量阶段页面异常/HTTP 错误，无超时。基线构建在解冻业务源码前完成，后续测量一直读取冻结的输出目录。

| 加载指标 | 三轮中位数 |
|---|---:|
| 首个画板 DOM | 600.754 ms |
| 字体与全部 image.decode 结束（旧驱动） | 616.028 ms |
| 全页 DOM 元素 | 27,641 |
| 挂载画板 / 便签 / 分区 | 200 / 100 / 20 |
| 加载请求数 | 23 |
| Resource Timing 编码正文合计 | 2,455,370 B |

加载长任务三轮分别为 2/2/2 个，总时长 369/313/305 ms。关闭技能面板后全页元素为 27,439，200 个画板仍全部挂载。

| 阶段 | 实际耗时中位数 | RAF p50 / p95 中位数 | ScriptDuration 中位数 | 最大 RAF 间隔（全部三轮） | 三轮长任务总数 |
|---|---:|---:|---:|---:|---:|
| idle | 2.014 s | 16.70 / 16.71 ms | 0.027299 s | 16.8 ms | 0 |
| pan：120 次移动 | 4.380 s | 16.70 / 16.72 ms | 2.571048 s | 283.3 ms | 0 |
| zoom：20 次点击 | 3.241 s | 16.70 / 16.80 ms | 0.557142 s | 33.4 ms | 1 |
| fit-all：含固定等待 | 1.654 s | 16.70 / 16.80 ms | 0.076532 s | 50.1 ms | 0 |

pan 阶段的 JS heap 三轮为 197,451,912 / 35,163,648 / 130,314,748 B，明显受 GC 时机影响；保留原值，不描述为稳定内存占用。pan/zoom 三轮均没有网络请求；fit-all 每轮有一次保存请求。LayoutDuration 中位数分别为 pan 0.000125 s、zoom 0.005086 s。

基线在本机多数 RAF 间隔已接近 16.7 ms，因此不能将本轮目标或结果描述为“从低帧率变成流畅”。后续重点比较同视野 DOM 数、处理同样输入的脚本工作量和耗时，并同时报告帧间隔与异常值。

已实际查看[基线末态截图](../../tests/perf/.artifacts/baseline-200x50-valid-20261031-041049/trial-1/board.png)。画板仍为真实文字/图片渲染，便签和分区可见。现有“适应所有方案”最低倍率 20%，该大网格不能全部装进 1440 × 900；截图只展示上部若干行，不应称为完整 200 板缩略总览。新版将以同一操作末态核对视觉结构，不以全页面像素百分比替代检查。

第一次探测运行 `baseline-200x50-20261031-040825` 排除在比较之外：当时脚本把登录前 401 算入失败，并且 pan 起点落到画板按钮，实际没有移动视口。保留报告，修正测量起点、阶段错误范围并加入 transform 断言后，以上三轮完整重跑；未通过改小 fixture 来改善基线。

## 后端独立基准：已执行

后端验证者使用 [board-api-benchmark.ts](../../tests/perf/board-api-benchmark.ts)，通过 Fastify.inject 调用实际服务代码和临时隔离 PostgreSQL；2 次预热、10 次采样，结束删除临时数据库。它不经过 HTTP 网络，也不是浏览器 fixture：200 板 × 50 个中文文字图层，不含便签、分区或图片。不能把这组耗时直接当作浏览器保存端到端耗时。

```sh
node --import tsx tests/perf/board-api-benchmark.ts
node --import tsx tests/perf/board-api-benchmark.ts --optimized
```

第一条用于相应旧代码基线；在新版上运行不会自动还原旧实现。已读取执行者保存的[旧版原报告](../../tests/perf/.artifacts/api-before-200x50.json)和[新版原报告](../../tests/perf/.artifacts/api-after-200x50.json)，采样时间分别为 11:10:19Z、11:13:38Z。

| 接口/模式 | 旧版 p50 / p95 | 新版 p50 / p95 | SQL 次数（旧→新） | 响应正文（旧→新） |
|---|---:|---:|---:|---:|
| GET studio 完整数据 | 38.07 / 44.36 ms | 38.86 / 47.17 ms | 8 → 8 | 1,933,503 → 1,933,503 B |
| PUT studio 保留完整响应 | 174.23 / 201.57 ms | 49.88 / 92.02 ms | 215 → 14 | 1,933,503 → 1,933,503 B |
| PUT studio 新 ack 模式 | 同上旧保存 | 14.89 / 35.85 ms | 215 → 13 | 1,933,503 → 157 B |
| GET 200 项目完整列表 | 35.56 / 39.27 ms | 37.30 / 53.88 ms | 6 → 6 | 1,958,412 → 1,958,412 B |
| GET 200 项目新 metadata 模式 | 同上旧完整列表 | 4.60 / 6.89 ms | 6 → 6 | 1,958,412 → 75,612 B |

保存已消除逐 Artboard 的 200 次 SELECT。完整 Studio 初始载入仍需要文档内容，响应体和本次耗时基本未变；不得将保存收益套用到初始 GET。metadata 是可选接口能力，当前项目列表仍需真实设计内容生成预览，不能称为列表 UI 已获得该模式收益。单项目 metadata 响应 388 B，也不替代编辑器完整文档读取。

## 大 Board 功能回归：已完成

已读取 [virtualization-20261031-044048](../../tests/e2e/.artifacts/virtualization-20261031-044048/report.json)：真实浏览器 **13/13**，无 pageerror/HTTP 错误，`fixtureRestored=true`。初始仅挂载20/200板；验证概览真实内容全部完成、快速变更视口取消旧挂载队列，以及全选320项（包括屏外成员）移动、撤销重做、全删恢复、分区拖动的屏外成员同步。

同时覆盖长拖动不被自动保存截断、pointer cancel一次提交、拖动中删除/撤销不复活旧组织、起点画板卸载后仍可平移、远处画板全局编号与真实精细编辑返回，以及项目重开只取一次完整Studio。该用例比较完整业务数据，不以当前DOM数量代表项目全部内容。一般Board18项、Editor14项、Import11项在本轮也已通过；整个系统最终回归由总验证记录汇总。

## 最终浏览器性能：3/3 通过

最终 [after-final-200x50-20261031-044650 报告](../../tests/perf/.artifacts/after-final-200x50-20261031-044650/report.json)，在全功能回归后独占运行，无其他浏览器/压测并行。三轮均 `processExitCode=0`、无超时、六预算全过、fixture hash一致、图片decodeErrors空、页面异常和HTTP错误均0。验证代码随后提交为 **`6d4d310`**；三轮执行时HEAD为后端阶段`9c1893d`，前端为该提交对应的待提交源码，包含SSE刷新广播合并。53文件摘要 `be7b970b03f1bce93acdf8d8e47d76ad4164a91890a4af00b159c3a72b70b7ff`，记录于 [source manifest](../../tests/perf/.artifacts/after-source-manifest-final.json)和每轮报告，运行后再次逐文件核验未变。

最终构建命令与基线相同，输出目录为 `tests/perf/.artifacts/build-after-final`，同一127.0.0.1:5175提供静态页面；JS 570.44 kB，gzip172.67 kB。运行命令：

```sh
python3 tests/perf/board_performance.py \
  --account-file /tmp/designx-perf-200-50.json \
  --label after-final-200x50 \
  --build-commit '9c1893d + final frontend be7b970b03f1' \
  --source-manifest tests/perf/.artifacts/after-source-manifest-final.json \
  --runs 3 --deadline 180 --check-budgets
```

| 同口径指标（三轮中位数） | 旧版 | 最终版 |
|---|---:|---:|
| 首个画板 DOM | 600.754 ms | 192.322 ms |
| 初始全页 DOM 元素 | 27,641 | 3,217 |
| 初始挂载画板 | 200 | 20 |
| 初始挂载便签 / 分区 | 100 / 20 | 8 / 4 |
| 加载请求数 | 23 | 23 |
| pan 120次实际耗时 | 4.380 s | 2.051 s |
| pan ScriptDuration | 2.571048 s | 0.043145 s |
| pan RAF p50 / p95 | 16.70 / 16.72 ms | 16.70 / 16.70 ms |
| zoom 20次实际耗时 | 3.241 s | 2.022 s |
| zoom ScriptDuration | 0.557142 s | 0.046729 s |
| zoom RAF p95 | 16.80 ms | 16.70 ms |
| fit-all完整操作（含固定等待） | 1.654 s | 1.594 s |
| fit-all RAF p95 | 16.80 ms | 16.73 ms |

最终首DOM三轮为292.216/191.066/192.322 ms，保留首轮波动，不只摘最快值。原版多数帧已近16.7ms；可观测收益主要是挂载规模、首DOM时间和处理同样输入的脚本工作量。初始资源编码正文合计2,455,370→2,453,119 B、请求数23→23，不构成明显初始网络流量减少。字体/图片就绪口径已变，不放入同口径对比表。

| 最终六项预算 | 三轮实测范围 | 上限 |
|---|---:|---:|
| 初始挂载画板 | 20 | 30 |
| 初始DOM元素 | 3,217 | 5,000 |
| pan RAF p95 | 16.7–16.8 ms | 20 ms |
| pan平均脚本/动作 | 0.351958–0.451758 ms | 8 ms |
| fit-all最大长任务 | 0 ms（无≥50ms任务） | 100 ms |
| fit-all RAF p95 | 16.73–16.8 ms | 20 ms |

最终每轮的idle/pan/zoom/fit采样最大RAF间隔均16.8ms，长任务均0；加载阶段记录的长任务也均0。fit每轮完成150画板+70便签+15分区，共235项，pending=0、target=rendered=实际DOM；其余内容保存在完整项目中。1.5s后的额外完成检查为14.330/16.056/9.980ms，包含检查通信开销，已计入总耗时。canvas scrollTop/Left始终0。

并非每项底层指标都下降：fit ScriptDuration中位数0.076532→0.084250s、LayoutDuration0.000691→0.037537s，反映按帧挂载真实节点的工作；最终RAF和完整挂载门槛同时通过。pan阶段live JS heap三轮为12,126,468/12,188,788/12,146,332B；旧版三轮随GC波动很大，不据此宣称固定比例内存节省。GPU/合成纹理内存未测。

每轮浏览器实际发生一次fit后的保存：PUT正文81,921 B，ack响应解码和网络正文均158 B，响应只含documentId/projectId/revision/updatedAt，没有snapshot。pan/zoom阶段请求数为0。旧版浏览器基线没有直接采集保存正文大小，因此不把独立API基准的1.93MB写成这组浏览器的旧流量。

已实际查看[最终截图](../../tests/perf/.artifacts/after-final-200x50-20261031-044650/trial-1/board.png)并对照基线同末态：侧栏、顶部操作、底部工具、真实中文/图片画板、便签和分区保留；此前22px原生滚动位移已消除。使用真实共享Renderer，没有以占位图或假预览替代画板。不宣称全页面像素完全一致或跨环境金样验证。

## 中间测量与纠正记录

首版优化测量 `after-200x50-budget-20261031-042255` 保留为中间结果，不能作为最终通过：前两轮初始挂载 20 板/3,217 元素，pan 原四项预算通过；fit-all 从局部挂载增加至 150 板，出现 146/157 ms 长任务。第三轮在 pan 前固定点命中检查失败，未执行完整用例；当时没有记录命中元素，不能确定原因。补入命中元素和失败截图记录后的独立诊断 `after-pan-diagnostic-20261031-042404` 在相同 (403,410) 点命中真实画布，pan 正常，但再次观察到 160 ms 的 fit-all 长任务。未修改原点或降低负载来规避该失败。

上述 fit-all 回退已反馈实现者，随后新增 ≤100 ms 长任务预算；按新预算重算诊断记录会失败。该轮保存请求实际 81,921 B、ack 响应 158 B，无 snapshot。源 manifest 为 `after-source-manifest-first.json`（HEAD `9c1893d` 加待提交前端，sourceSetSha256 `f25eaa8184bf93c36684575a20bb3d80a3699d73fe4617897beda0cfcb40f8b2`）。已实际查看该首版末态截图，导航、画板文字图片、便签和分区仍在，但右画布整体相对旧图上移约 22px，已反馈检查容器滚动；仍需以修正后的最终截图为准。

分帧真实挂载与 `overflow: clip` 修正后，`after-batch-diagnostic-20261031-043530`、`after-readiness-diagnostic-20261031-043648` 明确在图片 ready 阶段超时，后者记录上述三张屏外 lazy 图。不是 Chromium 启动失败，也没有页面异常或 HTTP 错误。补齐等待口径后，`after-batch-visible-diagnostic-20261031-043746` 单轮当时五项预算通过，fit pending=0、target=rendered=实际挂载数=235，canvas scrollTop/Left 均为 0；已实际查看截图确认22px位移消失。该诊断fit无≥50ms主线程长任务，但RAF p95为99.97ms、最大116.6ms，按最终第六项预算会失败；未作为最终验收。

因此没有仅凭长任务门槛收尾。保留真实图层的分帧挂载，并在 `.st-result` 增加 `will-change: transform` 后，`after-layer-diagnostic-20261031-043953` 单轮fit RAF p95=16.7ms、最大16.8ms、长任务0，完整150板/235项，总耗时1.589s；源码摘要 `8b785c026ba853c6932d8429829e315ad923c5f76c8a9861daea26076c64c953`。随后新增第六项fit RAF p95≤20ms，避免“长任务0但呈现调度间隔很大”仍被自动判定性能通过；最终以独立三轮为准。JS heap16.83MB不包含合成层/GPU纹理内存，不能用它证明该CSS没有图形内存成本。

未测范围包括 150 图层/板压力档、数百不同大图、低端移动设备、真实网络延迟、跨浏览器/跨机器、长时间内存增长和多人实时协作。未来档位需分别固定数据和 viewport，不与本次 200 × 50 的三轮结果混合。
