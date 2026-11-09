# ADR-0002：独立创作平台与 WorkX 执行组件提取

状态：Accepted，2026-11-08，依据用户明确批准的 Design X v2 实施方案。替代 ADR-0001 关于新回合使用 Codex SDK 的默认宿主选择；旧执行协议保留兼容排空。

业务控制面维持 TypeScript/Fastify、PostgreSQL、pg-boss。直接图片请求由独立 TS Image Worker 接 OpenAI Image API；不经额外对话模型或 E2B。媒体 Worker 使用 sharp，Renderer 使用共享 DOM 渲染器与 Chromium。

新 Agent 回合通过功能开关进入 E2B 固定模板中的 Codex app-server 0.166.0。从固定 WorkX 提交提取 Python RPC/Runner 和 Go matfs，保留来源及摘要；不引入 WorkX Python 业务后端或在线服务。授权、租约、配额、工具幂等与文档提交仍在 Design X 数据库事务执行。

R2 使用 Design X 私有 staging 和正式资产桶；不可变版本、项目关联清单、root-only 短期凭据及 matfs 精确视图共同执行权限。个人素材库不自动挂载。HTTP 直传与版本迁移为 Design X 新增能力，不能描述为 WorkX 已有完整实现。

OpenAI 固定 gpt-image-2.5-sunburst-2026-09-08、medium，不自动回退；同步外部 API 对浏览器异步。提交意图先持久化，受理未知不自动重发；媒体恢复不再次生成。用户额度未知预占最长 24 小时，之后释放并人工核对，供应商成本未知保持 NULL。

原生状态不是业务真相源。同一会话复用沙箱；权限缩小、状态损坏或宿主版本改变必须显式建立新上下文。观察断线只恢复同一 attempt 的 journal；旧执行不允许覆盖文档或正式对象。

后果：增加资产/生成/会话/账本迁移及独立进程运维，但避免一开始引入多语言业务服务和多套队列。项目、Board、Artboard、文档版本、Proposal/CAS、原有 CJK 和导出链路继续复用。

执行契约与模块映射见 [统一 v2 设计](../architecture/15-design-x-v2.md)，真实通过项和未验收项见 [v2 验收](../implementation/v2-verification.md)。生产部署不在本次动作范围。
