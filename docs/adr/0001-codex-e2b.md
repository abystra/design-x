# ADR-0001：E2B Sandbox 内 Harness 使用 Codex SDK

- 日期：2026-10-31
- 状态：**Accepted（用户明确决策）；集成未实现、未运行验证**
- 替代：原 AD-08/D-08 自研轻量 Agent loop、原 D-09 拒绝 E2B/Codex 的结论
- 当前阶段：先实现非 AI 系统链路，此 ADR 不表示 AI 已交付

## 决策

用户明确最终 AI 采用 **E2B Sandbox 内运行 Harness，Harness 使用 Codex SDK**。不再自行维护 LLM 工具循环作为默认 Agent 宿主。

React/Vite、TS/Fastify、PostgreSQL、pg-boss、S3 兼容存储、独立 Chromium Renderer 保持原方向。确定性 recipes 保留为控制面的业务编排；Agent 可以请求运行 recipes，不能改配方定义或绕过任务、权限和计量。

## 边界

| 组件 | 职责与数据所有权 |
|---|---|
| API / server-domain | 认证、workspace 授权、文档 ops/Proposal、资产、任务、配额、审计与持久化事件 |
| Worker / ai-runtime | E2B 生命周期、执行租约、运行身份、回合调度、事件摄取、对账与成果摄取 |
| E2B 内 apps/harness | 调用 Codex SDK，准备受限上下文与工作文件，经受限工具/API 请求业务动作，发出事件和成果 manifest |
| Renderer | 从已授权文档快照导出；沙箱截图或文件不能替代统一导出链路 |
| PostgreSQL / 对象存储 | 业务真相源 / 二进制成果与经批准的检查点；沙箱文件和 SDK thread 不是产品数据源 |

沙箱不持有数据库连接、E2B 管理密钥或对象存储主凭证，不直接写文档表。业务桥接逐次校验运行租约、workspace/project、工具权限、schema、预算及幂等键。代码执行限于沙箱工作目录和批准的网络目的地；控制面把工具参数、运行事件和成果均视为不可信输入。

Codex 认证经受控配置或代理提供，兼容方式在 AI 阶段验证；长期凭证不进入提示词、工具回包、持久化检查点或日志。沙箱出站和私有入站策略必须显式配置，不能认为 VM 隔离同时隔离了网络访问。

## 协议与恢复（应用设计，尚待实现）

记录 `runtime_run_id`、`turn_id`、`sandbox_id`、`codex_thread_id`、模板/SDK 版本、`attempt`、`lease_epoch`、心跳、截止时间、最后事件序号与检查点引用。Worker 租约、沙箱生命周期、SDK thread 与业务 turn/jobs 分开建模。

1. Worker 领取业务任务租约并创建运行记录，取得或恢复绑定的沙箱。
2. Harness 执行 Codex；受限工具以稳定 `tool_call_id` 请求控制面操作，重试不重复产生副作用。
3. 事件经运行身份/租约校验，按运行、attempt 与 seq 去重并落库，再写 outbox/SSE；浏览器重连读取服务端事件。
4. 文件成果经 manifest 校验和资产摄取，文档建议经 doc-core/Proposal。确认持久化后才能报告成功。
5. 取消或租约失效后撤销能力令牌，拒绝迟到副作用；对账处理孤儿任务与孤儿沙箱。
6. 有可用沙箱及 SDK 所需本地状态才尝试恢复原 thread；丢失时从经批准检查点恢复，或用业务上下文开启新 thread。**仅保存 thread ID 不构成跨沙箱恢复保证。**
7. 长时子任务/人工审批等待不占 Worker；沙箱按策略暂停或清理。暂停、连接、销毁与平台取消必须各有可审计状态，不能把 E2B 状态直接等同业务终态。

工具桥接可采用受限 HTTP/MCP，流事件/取消/审批映射由 Harness 适配；本 ADR 不声明尚未核实的 SDK 方法。OpenAI 官方也将处理认证、历史、审批和流事件的自定义客户端列为 app-server 使用场景；当前 SDK 路线保持不变，若选定版本无法满足必要能力，记录差距后再决策，不静默改换宿主。

## 当前阶段与后续验收

本阶段建设真实非 AI 项目、素材、文档、任务与导出闭环，只预留 AI 契约和能力开关。不创建收费沙箱，不调用模型，不以 fake 作为 AI 完成证据。

AI 阶段需固定 SDK/runtime/template 版本，验证真实账号和部署区域可用性、受限工具、事件去重、跨租户拒绝、Worker 重启、沙箱丢失、检查点恢复、取消与迟到结果、预算中止、凭证轮换及成果摄取。计入沙箱时间、模型和存储成本。原 China-first 控制面假设不代表 E2B/Codex 已满足对应部署或数据地域要求。

## 已读取的官方依据

- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)：TypeScript 包 `@openai/codex-sdk`，本地 thread 的启动、运行、继续与按 ID 恢复。
- [E2B 的 Codex 示例](https://docs.e2b.dev/agents/codex)：官方提供 Codex 沙箱运行路径；CLI 示例不等于本项目 SDK Harness 已实现。
- [E2B 生命周期](https://docs.e2b.dev/sandbox)、[持久化](https://docs.e2b.dev/sandbox/persistence)：创建/连接/暂停/恢复/销毁，销毁与暂停语义不同。
- [E2B 出站控制](https://docs.e2b.dev/network/internet-access)、[入站访问控制](https://docs.e2b.dev/network/restrict-public-access)：网络访问需独立限制。

阅读日期：2026-10-31。仅核对上述文档，未重新核验其他依赖版本、许可证、价格或合规结论。
