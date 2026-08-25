# ADR 0005: Use A Prime/Pi-style Surface

状态：Proposed。

## Context

Nausicaa 需要一个开发和直接使用的 TUI，但长期产品 UI 会独立演进。复杂子命令、配置 profile 和自研终端组件会扩大非核心代码，并让 surface 侵入 runtime。

## Decision

入口、TUI 和 settings 主要参考 Prime Agent 与 Pi：

- 直接复用 `pi-tui`。
- 一个 bin，默认交互，其他输出使用 mode/flags。
- 用户与可信项目两层 JSON settings，CLI 做单次覆盖。
- 凭据与普通配置分离。
- TUI 只消费 projection 和提交命令。

DeepSeek 只作为内部 service seam 和 composition root 的参考；不复制 Cordis。Codex 的安全与审批经验仍可研究，但不采用其入口和 TOML 配置风格。

## Consequences

- 与 TypeScript、`pi-ai` 生态一致，减少重复代码。
- 普通用户不需要理解 profile、插件树或 graph DSL。
- 未来 App 可以替换 TUI，而不改变 runtime。
- 如果 mode flags 失控，应先收敛功能，而不是立刻建立大型子命令框架。
