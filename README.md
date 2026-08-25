# Nausicaa

Nausicaa 是一个面向长程任务的轻量 Agent harness，探索高效并行、模块化协作、可恢复运行与高缓存命中的 Agent runtime。

项目目前处于早期设计与实验阶段，尚未提供稳定 API、CLI 或可发布版本。

## Principles

- KISS：保持小内核、少概念和清晰边界。
- DIY：自主实现差异化 runtime，复用成熟的通用基础能力。
- Model-forward：避免把弱模型时期的临时补偿固化进内核。
- Evidence-driven：所有性能与能力主张都必须通过可复现测试验证。

底层模型与 provider 能力计划基于 [`pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai)，避免重复实现模型调度与流式协议。

## Status

实现尚未开始。公开接口、安装方式与贡献流程会在第一个可运行版本完成后发布。
