# Reference Projects

参考项目用于提取已验证的边界和机制，不是待复制的功能清单。下面的差异描述是当前研究假设，必须在实现和实验中复核。

| 项目 | 主要借鉴 | Nausicaa 的边界 |
| --- | --- | --- |
| Pi / `pi-ai` / `pi-tui` | provider、模型、流式调用、极简 loop 和 TUI 组件 | 复用 `pi-ai` 与 `pi-tui`；不默认继承 coding-agent 的产品入口或 loop 语义 |
| DeepSeek Harness | Ledger/event log、Inbox、插件化、可重建请求 | 采用事实源与投影思路，扩展到多 lane 和 Advice 协议 |
| Prime Agent | 轻量入口、TUI、RLM 思想、持久状态、子 Agent 通信、长程调度 | 采用 Prime/Pi 风格 surface；Fukai 借鉴按需查询，不预设 Python REPL 是核心 |
| OpenAI Codex | 上下文纪律、执行边界、审批和可恢复协议 | 只研究内核边界和安全经验；不采用其入口或 TOML 配置风格 |
| Multica | 多 Agent 管理、团队协作和人机管理体验 | 未来 UI 参考；当前先做 UI 无关的 Agent runtime |
| Letta / OpenClaw / Claude Code | 后台 reflection、sleep/dream、background subagents | 不把 Dream/Reflection 本身称为原创，重点验证实时 Ledger 观察和 soft advice 的组合 |
| LangGraph 等 | fan-out/fan-in、后台运行和可恢复图 | 只吸收可验证的调度经验，避免先建立通用 graph 平台 |

## 研究纪律

- 明确区分已存在的先例、我们的设计提案和实验结果。
- 记录复用的许可证、版本和代码边界。
- 对每个“更智能”机制建立对照实验，而不是用概念命名代替收益。
- 关注 token 开销、缓存命中、延迟、噪声和恢复，而不只看演示效果。
