# Skill Discovery Alignment

状态：Phase 1 已实施，Phase 2 已接入现有运行时，Phase 3/4 待实施

日期：2026-09-07

本轮已按文末推荐决策落地：CLI 默认发现项目 Skill；不自动扫描用户 home；首轮只暴露 `name + description`；`--edges` 保持兼容语义，MCP 仍需显式配置和授权。

## 1. 目标

让 Nausicaa 的 Skill 使用方式接近 Prime Agent、pi-agent-coding 和 DeepSeek Harness 的共同模式：

```text
启动时发现本地 Skill 的元数据
  -> 首轮上下文提供可用 Skill 摘要
  -> 模型需要时调用 skill(name)
  -> 运行时按当前快照加载完整 SKILL.md
  -> 将正文作为受限、不可信上下文提供给模型
```

本提案不要求把所有 Skill 正文放入首轮上下文，也不要求默认启动外部 MCP。Skill 是上下文和工作方法，MCP 是可执行的外部能力，两者必须继续分开治理。

## 2. 参考项目的共同合同

| 项目 | 启动时可见内容 | 完整 Skill | 默认外部能力 |
| --- | --- | --- | --- |
| Prime Agent | name、type、description、location 等摘要 | 按需读取 | 业务 Skill 可选，集成通常需配置或登录 |
| pi-agent-coding | name、description、location 摘要 | 按需读取或显式选择 | 通常没有固定业务 Skill 包 |
| DeepSeek Harness | provider 合并后的 metadata catalog | 通过 `skill` loader 按需读取 | 由 provider/plugin 配置 |
| Nausicaa 目标 | name、description；来源不暴露绝对路径 | 通过 runtime-owned `skill` 工具读取 | MCP 继续显式配置和授权 |

共同点是“首轮看目录，后续取正文”。区别在于 Nausicaa 还要保留自己的快照、预算、权限和 Ledger 边界。

## 3. 当前实现盘点

当前代码已经具备核心机制。本轮已补齐 CLI 的默认项目 Skill 装配，剩余缺口主要在诊断细化、配置暴露和后续 TUI 展示。

| 位置 | 当前能力 | 当前限制 |
| --- | --- | --- |
| `src/mowe/edges/skills.ts` | 扫描 `SKILL.md`、解析摘要、处理重复名、限制大小和路径、按需加载正文和资源 | 库层有默认 roots，但生产 CLI 通常传入显式 `source.location` |
| `src/config/settings.ts` | `edges.sources` 支持 `skill`、`mcp`、`plugin`；源和 host grant 分离 | `edges.enabled` 默认是 `false`；Skill source 需要 `location` |
| `src/config/edge-factory.ts` | 禁用 source 不构造 adapter；构造和刷新状态可诊断 | Edge 总开关同时覆盖不同类型的 source |
| `src/cli.ts` | 默认装配项目 Skill source；Skill 使用固定 roots 和同名优先级；MCP adapter 使用 stdio/HTTP 配置 | 用户级 Skill 目录仍不自动扫描 |
| `src/runtime/skill-tool.ts` | catalog 与 `skill` schema 原子生成；名称匹配、正文和资源读取有界 | 只有非空且完整 catalog 才暴露工具 |
| `src/fukai/context-provider.ts` | 只把 metadata 渲染为 `<available_skills>`；有预算、数量、字节限制 | catalog 没有配对工具时不会注入 |
| `src/runtime/main-loop.ts`、`src/runtime/session-controller.ts` | 首轮和后续 Turn 使用同一 activation snapshot；预算不足时同时隐藏 catalog 和工具 | 默认没有 Skill source 时自然看不到 catalog |

当前默认值：

```text
edges.enabled = false
edges.refreshOnStart = false
```

现在 CLI 行为已接近 Prime/pi 的“默认发现本地 Skill 元数据”；库层和非 CLI embedding 仍可继续使用显式 source。

## 4. 目标行为

### 4.1 默认发现范围

第一阶段只自动发现本地、项目相关的目录，避免把用户机器上的任意外部能力带入工作区：

```text
<workspace>/.agents/skills
<workspace>/.pi/skills
<workspace>/skills
```

这些目录与 `src/mowe/edges/skills.ts` 当前库层的默认 roots 一致。用户级目录（例如用户 home 下的 Skill 目录）是否自动加入，作为单独决策，不在第一阶段隐式开启。

### 4.2 首轮模型请求

当发现至少一个有效 Skill 时，当前 activation 必须同时包含：

1. `skill` 工具 schema；
2. metadata-only 的 `<available_skills>` 块；
3. 与二者相同的 catalog generation 和 snapshot identity。

示例：

```xml
Available Skills (metadata only). When a request matches a listed Skill, call `skill` with its exact name to load the instructions.

<available_skills generation="12">
  <skill>
    <name>review-code</name>
    <description>Review changes for correctness and regressions.</description>
  </skill>
</available_skills>
```

首轮不包含：

- `SKILL.md` 正文；
- 任意 Skill 资源全文；
- 绝对文件路径；
- MCP server 的连接参数、header 或 secret。

### 4.3 按需加载

模型调用 `skill({ name })` 后：

1. 只接受当前 catalog 中的精确名称；
2. 使用捕获时的 registry snapshot，不在一次 Turn 中悄悄切换来源；
3. 对正文和资源执行现有字节、数量、路径和 workspace 约束；
4. 将结果标记为 Skill context / untrusted data；
5. 不因为 Skill 正文而扩大 host grant、工具集合或 shell/network 权限。

### 4.4 刷新

刷新发生在 activation 边界，不发生在模型请求中间：

```text
启动或显式 refresh
  -> 重新发现摘要
  -> 生成新 generation
  -> 下一次 Turn 使用新 snapshot
```

正在执行的 Turn 继续使用旧 snapshot。刷新失败保留旧 snapshot，并通过 diagnostics 暴露原因。

## 5. Skill 与 MCP 的开关边界

这是本提案最重要的设计约束。

### 推荐行为

- 默认自动发现本地 Skill 元数据。
- 默认不启动 MCP stdio 进程，也不连接 MCP HTTP endpoint。
- 默认不执行任何外部 Skill；Skill 只是被动提供上下文。
- 已配置的 MCP 仍要求 source 配置、host grant 和对应权限。

### 对现有 `--edges` 的处理

当前 `--edges` 是所有 Edge source 的总开关，包含 Skill、MCP 和未来 plugin。为了避免命令语义继续混淆，第一阶段不新增 `--skills`、`--mcp` 等新命令，也不立即改变 `--edges` 的兼容语义。

实现上应先增加内部 source policy，将“默认本地 Skill discovery”和“显式外部 Edge loading”分开：

```text
Local Skill discovery: 默认开启，只读元数据
Configured external edges: 继续受 edges.enabled / --edges 控制
MCP execution: 继续受 source + grant + capability 控制
```

后续是否拆分 CLI 开关，必须单独评审命令命名、迁移和帮助文本，不作为本提案的隐式改动。

## 6. 配置兼容策略

现有显式配置继续有效：

```json
{
  "edges": {
    "enabled": true,
    "sources": [
      {
        "sourceId": "team-skills",
        "type": "skill",
        "location": "./.agents/skills",
        "enabled": true
      }
    ]
  }
}
```

第一阶段不要求用户为默认项目目录写配置。建议新增一个内部的 `SkillDiscoveryPolicy`（名称可调整），而不是把默认目录硬编码进 MCP/Edge 配置：

```ts
interface SkillDiscoveryPolicy {
  enabled: boolean;
  roots: readonly string[];
  includeUserRoots: boolean;
  refreshOnStart: boolean;
}
```

这是设计接口示意，不代表现在已经接受该配置字段。若最终将其暴露到 `.nausicaa/settings.json`，需要增加 schema 校验、文档和迁移测试。

## 7. 建议的实施分期

### Phase 0：决策冻结

在写代码前确认：

- 默认是否扫描上述三个项目目录；
- 是否加入用户级 Skill 目录；
- Skill catalog 是否只包含 name/description；
- `--edges` 是否保持兼容语义；
- 刷新是否只在下一次 activation 生效。

### Phase 1：默认本地 Skill source（已实施）

已新增 `src/config/skill-discovery.ts` source policy/装配层，并在 CLI composition root 接入：

1. 在 CLI composition root 解析 workspace Skill roots；
2. 没有显式 Skill source 时加入默认本地 source；显式 Skill source 继续由用户配置并优先承担发现职责，避免同一 Skill 被两个 source 重复发布；
3. 对 sourceId、root 顺序和重复 Skill 做稳定排序；
4. 不让默认 Skill source 打开 MCP 或 plugin；
5. 保留显式 `edges.enabled=false` 对外部 source 的关闭能力；
6. 保持 registry snapshot 和 generation 原子不变；
7. `--no-edges` 显式关闭隐式本地 Skill source；预留 source ID 冲突时不重复注册。

优先复用 `createSkillsEdgeAdapter`、`MoweEdgeRegistry` 和现有 `SkillSummary`，不另造一套 Skill loader。

### Phase 2：首轮 catalog 合同（已有实现，本轮补充装配回归）

补齐并固定以下行为：

1. 非空 catalog 必须和 `skill` schema 同时出现；
2. budget 不足时二者同时隐藏；
3. generation、identity、snapshot 在日志和测试中可验证；
4. catalog 只含 metadata，不含正文和绝对路径；
5. catalog 顺序稳定，避免模型缓存前缀无谓变化。

现有 `FukaiContextProvider` 和 `createRuntimeSkillCapability` 已覆盖大部分实现，重点是装配和回归测试。

### Phase 3：刷新、诊断和配置

1. 启动发现失败不阻塞普通对话；
2. `edge-status` 或 JSON diagnostics 显示 source、generation、数量和错误；
3. `--refresh-edges` 继续刷新显式 Edge，并同步约定本地 Skill 是否刷新；
4. 不在诊断或模型上下文中打印 secret、header 和 Skill 正文；
5. 补充 settings 示例，但不把实验字段误写成稳定 API。

### Phase 4：TUI 展示（非本提案必需）

TUI 只展示发现状态和摘要计数，例如“Skills 8 / generation 12”，不在主对话中重复打印完整 Skill 正文。TUI 风格和交互另立设计文档。

## 8. 测试和验收标准

### 单元测试

- 默认 roots 按固定顺序发现；目录不存在时不报 fatal error。
- 无效 frontmatter、符号链接、越界文件和重复名称产生稳定 diagnostics。
- catalog 只包含 name/description，正文不进入 catalog。
- catalog 与 `skill` tool 成对出现；任一缺失时两者都不进入模型请求。
- 输入预算不足时保留主请求，成对移除 Skill catalog/tool。
- `skill(name)` 只能加载当前 generation 中的精确名称。
- Skill 资源不能越过 Skill 目录、workspace 或大小限制。
- 刷新生成新 generation；正在运行的 snapshot 不被修改。

### 集成测试

用临时 workspace 创建 `.agents/skills/review-code/SKILL.md`，验证首轮模型请求：

```text
tools 包含 skill
messages 包含 available_skills 和 review-code
messages 不包含 SKILL.md 正文
```

随后让脚本模型调用 `skill("review-code")`，验证下一次工具结果包含正文且被标记为受限 Skill context。

### MCP 回归测试

- 未配置或未显式开启时，不启动 MCP 子进程、不连接 HTTP endpoint。
- 配置了 Skill 默认 source 时，MCP tool 不会因此出现。
- 现有 `--edges`、`--no-edges`、source `enabled` 和 host grant 行为不回归。

### CLI 验收

- 不新增未经批准的用户命令。
- `--help` 明确说明 `--edges` 是外部 Edge source 开关，而不是“加载所有 Skill 正文”。
- 非 TTY、`--json` 和 daemon 模式使用同一份 Skill snapshot 合同。

## 9. 安全与性能边界

Skill 文件属于本地输入，不应被当成 host policy：

- Skill 正文不能放宽 shell、write、network、MCP 或 A2A 权限。
- catalog 不暴露绝对路径、环境变量、认证信息或 MCP headers。
- 每次正文和资源读取继续使用现有 byte/count/path limits。
- 默认发现只读取 metadata；启动不执行 Skill 中的命令。
- 发现和刷新必须有界，不能因为一个 Skill 目录卡住主 CLI。
- catalog 的 token 成本计入 Fukai budget，不能无限增长。

目标性能是：普通启动只做有界 metadata scan；模型只有明确调用某个 Skill 时才读取正文和资源。

## 10. 不在本提案中的内容

- 默认启用任意 MCP server。
- 把全部 Skill 正文预注入 system prompt。
- 新增 `/skills`、`--skills` 或其他 CLI 命令。
- 把 Skill 当作可执行脚本或权限配置。
- 引入 Prime 的持久 IPython/Python runtime。
- 改造 TUI 的视觉风格或输出去重逻辑。
- 建立通用 plugin marketplace。

## 11. 需要批准的决策

在 Phase 1 开始前，请确认以下四项：

1. 默认项目 roots 是否采用 `.agents/skills`、`.pi/skills`、`skills`。
2. 第一阶段是否完全不自动扫描用户 home 下的 Skill。
3. 首轮 catalog 是否固定为 `name + description`，不暴露 location。
4. `--edges` 是否保持现有兼容语义，并通过内部 policy 实现“默认本地 Skill、外部 MCP 仍关闭”。

推荐答案是：`是、是、是、是`。这样能获得 Prime/pi/DeepSeek 的主要使用体验，同时不把 MCP 和第三方执行能力意外打开。

## 12. 参考源码和资料

- `src/mowe/edges/skills.ts`
- `src/runtime/skill-tool.ts`
- `src/fukai/context-provider.ts`
- `src/runtime/main-loop.ts`
- `src/runtime/session-controller.ts`
- `src/config/edge-factory.ts`
- `src/config/settings.ts`
- `src/cli.ts`
- `HARNESS-CAPABILITY-COMPARISON.md`
- `TOOL-CALL-FLOW-SIMULATION.md`

## 13. 模型按需加载的资源位置补齐（2026-09-09）

本轮核对 Prime Agent `v0.7.2`，commit
`7787f07415d843b9a800f6a4720e0c739bd608e5`（MIT，copyright 2025 Mario
Zechner、2026 Prime Intellect）。其
`packages/coding-agent/src/core/skills.ts:450` 的 `formatSkillsForPrompt`
提供 `name / type / description / location`，要求任务匹配时读取正文，并以
Skill 文件所在目录解析相对引用。`core/system-prompt.ts` 在存在文件读取工具时
加入目录；`core/resource-loader.ts` / `loadSkills` 负责启动发现。
`core/package-manager.ts:436` 收集项目祖先的 `.agents/skills`，`:2181`
加入 `~/.agents/skills`，由 resource loader 传给 `loadSkills`。

复用边界是“匹配描述后按需加载、相对引用有明确基准”。直接依赖 Prime session
或移植整个 loader 会带入其 IPython、用户目录策略和 session 所有权，超出当前
需求；继续使用现有 registry/loader 的薄适配，没有引入新依赖或执行环境。

实际缺口在模型调用 `skill(name)` 后：filesystem adapter 和 registry 已提供
可信 `skillLocation`，runtime validator 只保留了 `resources`，丢失了文件位置。
现在正文和资源结果带有 `skillLocation: { filePath, baseDirectory }`（若 adapter
提供），让后续脚本和资源路径有明确基准。首轮 catalog 仍只包含名称、描述，
正文和绝对路径都在模型请求加载后才提供；该信息不授予任何执行或目录访问权限。
目录前导也明确提醒匹配的任务调用 `skill`，不强制每次请求加载无关 Skill。

默认发现范围继续是工作区 `.agents/skills`、`.pi/skills`、`skills`，加上三个内置
Skills；不自动扫描 `~/.agents/skills` 或 `~/.codex/skills`。这意味着只安装在个人
目录中的 Skill 不会出现在 Nausicaa 的目录中。当前工作区没有上述三个项目目录，
默认可用项来自 `assets/skills`：`codebase-map`、`code-review`、`task-plan`。
本轮实际 discovery 得到 3 项，描述分别为 138、157、170 UTF-8 bytes；渲染目录
900 bytes，`complete=true`，diagnostics 为空。
项目 Skill 应放在 `<workspace>/.agents/skills/<name>/SKILL.md`；仅设置一个工作区外
location 不会绕过现有 workspace 访问边界。

单条描述超过 512 UTF-8 bytes 会在 runtime catalog capture 时独立跳过并记录
`description-limit`，其余有效项保留；整个 catalog 超过 128 项或 32 KiB 才整体
隐藏。模型请求的 context budget 不足时，catalog 和 `skill` schema 同时隐藏。

请求边界回归覆盖 one-shot `executeRun` 和交互 `SessionController` 的同一条链路：
首轮 metadata + schema → `skill(name)` 正文及目录 → `skill(name, resourcePath)`
引用资源。验证通过 model port 捕获实际构建的请求，不调用付费模型。
相关 7 个测试文件共 103 项通过，包含上述两种入口、目录/工具原子可见、字节限制、
显式 `/skill:`、内置 Skills、路径和符号链接边界。
