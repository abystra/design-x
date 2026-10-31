# E2B / Codex SDK / DeepSeek 实际验证

2026-10-31，阶段 1 已完成真实调用；产品 AI 入口和 tldraw 接入属于后续阶段，不能据此认定已交付。

## 已运行的组合

| 项目 | 实际值 |
|---|---|
| E2B 官方 TS SDK | `e2b@2.62.0` |
| 指定模板 | `u1yrkaokyjzef8qchho5`（用户提供的官方 codex 模板） |
| 模板内环境 | Node `20.9.0`，Codex CLI `0.164.0` |
| Harness SDK | `@openai/codex-sdk@0.166.0`，打包后送入沙箱，显式使用预装 `/usr/local/bin/codex` |
| 模型 | `deepseek-flash`，自定义 provider，`https://api.deepseek.com`，Responses API |
| 网络 | 私有沙箱入口，出站仅放行 DeepSeek；未在沙箱安装额外 npm 依赖 |

[Harness](../../apps/harness/src/main.ts)通过 SDK `runStreamed` 执行两轮。第一轮使用 shell 读取仅存在于沙箱文件中的随机 nonce 与数字，计算总和并写入 proof.json；第二轮沿用同一 thread，读取产物、修改数值并写回。控制面比较两轮产物和最终远端文件，检查工具事件、完成事件、usage 和 thread ID。不以“回复成功”替代工具执行证据。

最终报告时间 `2026-10-31T12:53:36.832Z`（UTC），sandbox `ixlfbdimy1km6vhupp8jr`，thread `01a19205-9de1-7201-a5e7-2268ca6c7eb0`。两轮各有 2 次 command_execution 完成事件；输入 nonce 保持一致，结果依次为 57、62。报告位于被 Git 忽略的 `tests/ai/.artifacts/runtime-verification.json`；运行结束 `sandbox.kill()` 成功。

## 实际发现与边界

第一次验证的模型和工具均完成，但最终自然语言回复未遵守要求的 JSON 格式，不能解析为可信设计文档。该轮因此失败并清理沙箱。修正后明确区分用户消息与文件成果：模型工具写出真实 JSON 文件，Harness 读取，控制面严格校验。没有用正则从回复里猜测 JSON，也没有模拟成功结果。

因此 SDK 的 outputSchema 在此组合上**不能作为唯一数据保证**。后续业务层必须校验 schema、资源引用、权限、版本和任务 fence，失败不得落库。DeepSeek 原生 Responses 为无状态接口；会话由 Codex 本地状态及产品持久化管理，不依赖供应商 `previous_response_id`。

本阶段证明模板可用、provider 实际调用、流式事件、工具执行、同 thread 续聊与文件回收；尚未证明产品画板生成、视觉参考图、长上下文压缩、取消恢复或 Worker 崩溃后的沙箱对账。这些需在后续接入阶段验证。

## 复现

在本地忽略文件 `.env.ai.local` 配置 `E2B_API_KEY`、`DEEPSEEK_API_KEY`、`E2B_TEMPLATE_ID`、`DEEPSEEK_MODEL`，权限设为 0600。文件不得提交。执行：

```sh
pnpm verify:ai-runtime
```

该命令创建真实收费沙箱并调用模型，结束回收沙箱；不应作为每次普通单测的隐式前置。源码只记录环境变量名，stdout 仅输出受控事件类型、usage、ID 和检查结论；CLI 原始 stderr 不向应用日志转发。自然语言和成果均视为不可信内容。

模型 catalog 来源：[DeepSeek Codex 配置](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)，保留两种型号的工具协议和能力字段，改用 Design-X 指令。其 `auto_compact_token_limit:null` 表示沿用客户端默认，不是禁用压缩。相关运行依据：[E2B Codex](https://docs.e2b.dev/agents/codex)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)。
