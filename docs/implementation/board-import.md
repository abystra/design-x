# Board 便签、分区与原生项目导入

状态：Board 专项 **17/17**、跨账户导入浏览器专项 **11/11** 通过；后端导入专项 **10/10**、包含全部模块的真实 API 回归 **29/29** 通过。本轮 Board 已提交 `5f7a263`，持久化导入已提交 `2291383`；最终验收文档随下一次提交。

## 已实现范围

Board 沿用现有 DOM 工作区。便签支持正文、颜色、位置和尺寸；分区支持标题、颜色、位置、尺寸与显式成员。分区只包含 Artboard 或便签，不嵌套，一个对象只能属于一个分区。拖动分区带动成员，混合选择分区和成员时每个对象只移动一次。移动成员**不会自动退出分区**，归属由“加入目标分区”“从分区移出”明确修改；删除分区保留未选中的内容。

混合复制创建新 Artboard 文档和新便签/分区 ID，并重写成员映射。移动、复制、删除支持撤销/重做与服务端保存。Board PUT 使用 revision 乐观锁；409 保留当前本地输入，可下载草稿，或明确放弃本地后载入远端。此处不承诺未保存 Board 刷新后自动恢复或自动合并冲突。空 Board 从项目列表重开仍进入工作区，不再落入隐藏主画板编辑器。

共享 [Board schema](../../packages/doc-core/src/board.ts) 校验实际 snapshot：notes/sections 默认空数组，全部条目 ID 唯一，禁止悬空、重复归属和嵌套成员。Artboard 正文仍由独立 documents 行提供，不从旧 Board 快照覆盖。[架构示例](../architecture/07-data-and-interfaces.md)中的完整 designx.board/items 格式尚未整体替换当前兼容格式。

Board 顶部可下载原生项目包；“我的项目”可导入文件。导入创建当前账户的新项目、文档和私有素材，不覆盖来源项目。任务接收后关闭弹窗仍继续处理，可从“创作动态”打开结果。

## 文件格式、接口与限制

`.dxproj` 是自包含 **JSON v1**，不是 ZIP：format 为 `designx.project`，schemaVersion 为 1，包含 title、documents、assets，以及新导出的 primaryArtboardId。assets 的键为资源路径，值为 PNG/JPEG/WebP/GIF 的 base64 data URL。导出收集 Artboard 和 Board 引用，包括仅出现在 Board assets/attached 中的素材。

`POST /api/projects/import` 接受 multipart file 字段及 .dxproj 文件名，返回 202 和 project.import 任务 DTO。任务完成后的 result.projectId 才是新项目；HTTP 202 不代表导入成功。结构错误、未知版本、缺失文件、非法来源路径和损坏 base64 返回 422，源文件超限返回 413。图像实际解码、声明 MIME 与实际格式不符或数据库/存储错误可能在提交后使任务进入 failed。

按 [导入格式实现](../../packages/server-domain/src/import-format.ts) 的限制：

| 项目 | 上限 |
|---|---|
| .dxproj 源文件 | 40 MiB |
| 单素材 base64 解码后字节 | 10 MiB |
| 所有素材解码后字节总和 | 30 MiB |
| 素材条目 | 200 |
| Artboard | 1–100；最多 1 个 Board |
| 图层总数 | 10,000；每画板仍受 Artboard schema 限制 |
| 单图 / 总图像像素 | 40 MP / 100 MP |
| 标准化图片与缩略图存储预算 | 64 MiB |

JSON 层另限制嵌套深度和条目数；Board/图层尺寸、文字和数量沿用共享 schema。旧 designx-studio-session 浏览器存档不是原生导入格式。完整有效的 v1 包可导入；旧包若缺少 Board 引用的私有图片会明确拒绝，不访问来源账户或外部网址补图。未知 schemaVersion 被拒绝，没有自动升级链。

## 资产、权限与失败恢复

[导入 Worker](../../apps/worker/src/import-project.ts) 使用 Sharp 实际解码，标准化为私有 PNG 文件并生成 WebP 缩略图；GIF 按首帧处理。同一个包内按内容哈希复用重复文件，导入不是源图字节不变的文件备份。项目、文档、图层/组合、便签、分区、成员，以及支持的选择/引用/消息/素材元数据映射到当前空间。正文、标题、提示词等用户文本保持原文，不把其中偶然出现的旧 ID 当成可执行引用。

来源 project/document/asset ID 不继承权限。新私有文件由新空间授权，A 不能读取 B 的副本，B 不能读取 A 的原文件。导入创建初始“导入版本”，不恢复来源账户权限、会话或正在执行的任务。

同一幂等键和相同文件复用接收任务，复用键但改变内容会冲突；重试已有任务使用固定目标项目和 ID 映射。项目、文档、素材、引用及任务成功状态在同一数据库事务完成。S3 写入不是数据库事务的一部分：每次执行记录 staging manifest，失败补偿只清理本次未提交对象，reconciler 回收中断遗留 staging，已被成功资产引用的对象不删除。

成功后尝试删除上传的源包；失败源包保留供任务重试。尚无长期失败源包的定时清理，不宣称已实现通用对象存储 GC 或灾难恢复。

## Board 浏览器专项

命令：`pnpm test:board`（python3 tests/e2e/board_features.py）。最终运行 ID：`board-20261031-032903-85d955`，**17/17 通过，退出码 0，页面异常 0 条、HTTP 5xx 0 条、真实 409 一次**。无 mock、未使用 --core。

- 便签中文/换行、宽 320、高 240、颜色 #CCE8DF 写入并重开。
- 从便签创建分区；Artboard 加入、移出、再次加入，显式成员关系保存。
- 混合选中分区和便签拖动，各对象仅平移一次 (80, 50)；独立便签移动不改变其他位置或自动改变归属。
- 混合复制创建一个新 Artboard、便签和分区，ID 唯一且新成员全部指向副本；新文档内容正确。
- 删除分区保留成员；移动/复制/删除分别撤销重做，精确比较服务端组织数据，刷新后一致。
- 下载 4,126 字节 board.dxproj；Renderer 任务 b263551d-f2d4-495d-aebd-c87c99029516 成功，包内便签/分区/成员与文档一致。
- 真实竞争写入后 UI 收到 409，保留本地便签并能下载草稿，服务端未被覆盖；明确放弃本地后显示远端。
- 全选清空 Board、离开、从项目列表重开，仍为空 Studio；隐藏主 Artboard 正文未被误删。

证据：[报告](../../tests/e2e/.artifacts/board-20261031-032903-85d955/report.json)、[重开截图](../../tests/e2e/.artifacts/board-20261031-032903-85d955/03-organized-reopened.png)、[空 Board](../../tests/e2e/.artifacts/board-20261031-032903-85d955/05-empty-board-reopened.png)、[项目包](../../tests/e2e/.artifacts/board-20261031-032903-85d955/board.dxproj)。同目录保留 trace、冲突截图和草稿，均被 Git 忽略。

此前 --core 运行 board-20261031-032451-ce945a 为 5 项、状态 partial；board-20261031-032638-a0057f 为 16 项，缺少空 Board 回归。以上述最终 17 项为完整专项。Python 编译与 git diff --check 已通过。

## 跨账户导入浏览器专项

执行者在 `2291383` 后运行 `python3 tests/e2e/project_import.py --accounts-file <私有临时测试凭据文件>`，默认无参数入口为 `pnpm test:import`。最终报告 `import-20261031-033751-4b8b83` 已读取：**11/11 通过，页面异常 0 条、HTTP 5xx 0 条，无 mock**。`authenticationMode=login-reused-test-accounts`：两个独立 browser context 通过真实 UI 登录此前由本测试创建的隔离账户，全部 fixture 项目重新创建。它不是再次注册成功的结果。API 准备真实数据与核对持久化，导出/导入/编辑等操作通过 UI 完成。

- A 项目含 2 个 Artboard、便签、分区、私有图片与 Board-only assets/attached/thumbnail，真实 UI 导出 2,499,070 字节；实际包内有 2 张 PNG 和 1 张真实 WebP 缩略图。
- B 在“我的项目”上传并打开新项目；验证文档、条目、图层/组合、资产及 selected/selection/reference/message 引用映射。
- A/B 互访对方项目和图片返回 404，各自能读自己的私有资源。
- B 刷新后继续编辑、保存，再导出 2,563,169 字节项目包。
- 非法 JSON、未知版本不新增项目/任务；已接收任务在关闭弹窗后继续完成，可从创作动态打开。
- 390px 下长文件名弹窗、焦点循环、ESC 回焦通过。测试发现项目页三个操作按钮横向溢出，修正换行后整轮重跑通过；执行者实际查看截图确认没有横向溢出。

证据：[报告](../../tests/e2e/.artifacts/import-20261031-033751-4b8b83/report.json)、[导入后 Board](../../tests/e2e/.artifacts/import-20261031-033751-4b8b83/02-imported-board.png)、[390px 弹窗](../../tests/e2e/.artifacts/import-20261031-033751-4b8b83/03-mobile-import-dialog.png)。原导出器将 thumbnail 路径错误打包为原图字节，已在 2291383 修正；修正后真实 API 用例验证导出的原图 PNG、缩略图 WebP 的 MIME 与 SHA256 分别匹配原文件，并验证 B 导入标准化 PNG 的字节哈希；该证据独立于上述浏览器 URL 映射检查。

此前 `import-20261031-033332-ac996f` 与其他验证并行，触发共享 IP 的 600/min 限流，跨账户请求得到 429，严格 404 断言未放宽；`import-20261031-033444-3fab52` 的第二个注册请求触发 12 次/15 分钟限流。两次失败保留报告，不计为通过。最终独立重跑使用既有隔离账号，不修改产品限流、不重启 API；临时凭据文件权限 0600，结束后已删除，内容未写入报告或提交。已实际查看最终 390px 截图，弹窗与长文件名没有横向溢出。

## 单元与真实 API 证据

已阅读 [Board 单测](../../tests/unit/board.test.ts)和 [Board API 用例](../../apps/api/tests/board.integration.test.ts)，实施者报告新增 **3/3**、**4/4**，全部单测 **10/10**。覆盖旧数据默认值、成员/ID/坐标验证、真实存取、无效写入与 409 不变、跨账户 404、删除框保留内容与 inverse 记录、无效画板位置不创建数据。

后端实施者报告 [import.integration.test.ts](../../apps/api/tests/import.integration.test.ts) 缩略图修正后 **10/10**、34.3 秒、TypeScript 通过，使用独立真实 PostgreSQL/S3/Worker/Renderer，并清理测试子进程和数据。覆盖真实跨账户导出导入、隐藏主画板、Board-only 资源、非法格式/引用、file/thumbnail 不同字节映射、MIME 伪装/超像素异步失败、幂等与固定目标重试、事务失败不产生半项目、staging 补偿及模拟中断 manifest 回收。随后执行 `pnpm test:api`，**29/29 通过、0 失败、46.46 秒**（Board 4 / Core 6 / Import 10 / Media 3 / Safety 6）。运行前停止长期 Worker/Renderer，结束后恢复并确认 ready，API 健康 200。

## 尚未覆盖或尚未交付

- Board 组织撤销与精细编辑同时发生的专门组合用例、真实中文输入法、50%/150% 多倍率交互专项仍未覆盖。
- 浏览器未专测删除 A 的来源项目后 B 仍可导出；全部容量边界、任意进程终止点和真实网络分区的恢复未穷举。
- DOM Board 尚无空间虚拟化；200 画板规模性能、多人实时协作、自动冲突合并、完整离线应用、生产部署/恢复演练未实现或未验收。
- AI 未接入；本轮未运行 Codex SDK 或 E2B Sandbox。

整体回归以 [验证记录](verification-results.md) 为准。专项通过不能替代上述未覆盖项。
