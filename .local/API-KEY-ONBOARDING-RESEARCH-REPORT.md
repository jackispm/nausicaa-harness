# Nausicaa 首次启动与 API Key Onboarding 研究报告

版本：`onboarding-research-2026-09-01.v1`  
基线：`main@c9bf6841f08f7d04afa646c92814c17b7a2fb6b5`（`update beta documentation status`）  
范围：只做本地代码/文档研究，不联网、不读取或写入真实 key，不修改运行时代码。

## 结论摘要

Nausicaa 目前是工程师式启动：模型必须来自 `--model` 或 `NAUSICAA_MODEL`，OpenRouter
凭据由 `pi-ai` 在真正 provider 请求边界解析 `OPENROUTER_API_KEY`。Nausicaa 自己没有
`login`/`logout` 命令、没有 keychain/凭据文件接入、没有 TTY 首次启动向导，也没有自动
加载 `.env` 的代码。README 的 `export` 示例是使用说明，不是实现。

beta 建议只做一个小方案：在 TTY 启动时增加本地、无网络的可跳过引导和状态查看，凭据
仍只从当前进程环境读取；引导不保存或回显明文 key，并给出可复制的 shell 命令。非 TTY
直接失败并给出相同下一步，绝不等待 stdin。之后再以独立扩展接入 `pi-ai` 的 `Models.login`
和成熟 OS 凭据存储，届时才提供持久化登录/退出登录。

## 1. 证据表

下表中的引用均为本机 checkout 的路径和提交；上游文字没有复制到本报告。

| 维度 | Pi（`../pi`, `1defa151e0c1dac87d38a2d0ac09d67f817b30f9`, MIT；`@earendil-works/pi-coding-agent@0.84.3`） | Prime Agent（`../primeagent`, `7787f07415d843b9a800f6a4720e0c739bd608e5`, MIT；`@earendil-works/pi-coding-agent@0.7.2`） | DeepSeek Harness（`../deepseek-harness`, `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, MIT；`@deepseek-ai/dsh-llm-deepseek@0.1.1-rc.2`） | Codex（`../codex`, `31d338a1ea89cd65a48d8ac07f50bb3917009806`, Apache-2.0） |
|---|---|---|---|---|
| 首次启动 | `docs/quickstart.md:35-45` 先 `pi`，然后手动 `/login` 或环境变量；无强制向导。无模型/无 key 的提示在 `packages/coding-agent/src/core/auth-guidance.ts:6-24`。 | `packages/coding-agent/src/modes/interactive/onboarding.ts:21-45` 按“首次显示 + 当前模型无 auth”决定 onboarding；Prime provider 有专门 splash（`components/prime-onboarding-splash.ts:51-123`）。 | Web 首次配置明确走 Settings → Models（`docs/user/guide/index.md:7-15`）；一键 headless/SDK 仍依赖环境或 `.env`（`docs/development.md:92-101,137-149`），没有统一阻塞式 CLI 向导。 | `cli/src/main.rs:131-147` 将 Login/Logout 作为显式子命令；`cli/src/login.rs:366-420` headless 时优先 device-code，失败可回退浏览器，不把普通启动变成隐式登录。 |
| 登录/退出登录 | 交互 `/login` 与 `/logout`（`docs/usage.md:39-43`）；API auth 命令只接受 provider/model（`src/cli/auth-command.ts:39-117`）。 | `modes/interactive/auth-flows.ts:144-195` 先选 provider 再走 OAuth/API-key dialog；`auth-flows.ts:197-244` 明确 `/logout` 只删除存储凭据，环境变量和 `models.json` 不变。 | Models 页面保存/删除 provider key（`docs/user/guide/providers.md:7-27`）；授权和 credential seam 是独立服务（`docs/subsystems/credentials.md:64-95`）。没有把 CLI 启动绑定为 login。 | `Login`、`Logout`、`Login Status` 的命令定义在 `cli/src/main.rs:131-147,490-543`；stdin key 入口拒绝交互终端并提示管道用法（`cli/src/login.rs:277-315`）。 |
| key 存储 | `packages/coding-agent/src/config.ts:542-544` 默认 `~/.pi/agent/auth.json`；`packages/coding-agent/src/core/auth-storage.ts:1-7,108-123` 负责文件、锁和 `0600`。 | `packages/coding-agent/src/core/auth-storage.ts:108-123,247-275` 同样是锁定的 `auth.json`，并有只存在进程内的 runtime override（`auth-storage.ts:277-291`）。 | `credentials-local/src/index.ts:1-34,96-145` 管理 `$DSH_HOME/.credentials.yaml`，拒绝非 owner-only 权限；settings 只带 `CredentialRef`，UI 只看 descriptor（`packages/credentials/credentials/src/index.ts:114-145,161-208`）。 | auth 结构包括 `$CODEX_HOME/auth.json`（`login/src/auth/storage.rs:39-65,154-203`）；配置可选 OS keyring，失败再回退文件（`storage.rs:251-321,408-457`；`core/src/config/mod.rs:820-839`）。 |
| 环境变量 | `docs/quickstart.md:56-67` 以 `ANTHROPIC_API_KEY` 为例；`packages/ai/src/auth/helpers.ts:2-29` 是“stored credential 优先，否则首个 env”。 | `core/auth-storage.ts:810-817,832-847,937-961` 记录 runtime/Prime 特例/存储/env/fallback 的解析顺序。 | `llm-deepseek/README.md:11-19` 默认 `apiKeyEnv: DEEPSEEK_API_KEY`；`llm-deepseek/src/index.ts:101-108,412-431` 每次请求解析引用，未配置才报结构化错误。 | `login/src/auth/manager.rs:910-930,1447-1494` 定义 `OPENAI_API_KEY`、`CODEX_API_KEY`、access token 并明确优先级；不等于 Nausicaa 的变量。 |
| 模型选择/默认值 | `/model` 或 Ctrl+L，Ctrl+S 保存启动默认（`docs/quickstart.md:130-132`）；catalog/model registry 可在无 stored auth 时解析模型（`docs/sdk.md:438-454`）。 | 模型 selector 与 provider selector 分离；`modes/interactive/components/model-selector.ts`、`onboarding.ts:32-45` 在选择后重新检查 auth。 | settings/catalog 声明 route 和 model，Web Models 页保存后立即可用（`docs/user/guide/index.md:7-15`；`llm-deepseek/README.md:39-50`）。 | `core/src/config/mod.rs:290,614-638` 读取可选 model/provider 并有 catalog；TUI/CLI picker 是显式选择，不以 key 推断模型。 |
| CI/非 TTY | `docs/quickstart.md:147-155` 用 `pi -p`；环境变量路径无需交互。API auth 命令也有 `--json`（`src/cli/auth-command.ts:18-45`）。 | 继承 Pi 的 print/headless 路径；交互 auth flow 需要 TUI，不应在 CI 等待。 | `docs/development.md:94-101` real-API e2e 在缺 `DEEPSEEK_API_KEY` 时自跳过；SDK/Headless 用 env，不要求 TUI。 | `login.rs:277-315` 非 TTY 只读 stdin secret；device-code fallback 明确给远程/无浏览器用户可用路径（`login.rs:366-420`）。 |
| 缺 key/无效 key/网络失败 | 无模型/无 key guidance 只说明 `/login` 和文档（`core/auth-guidance.ts:14-24`）；真实请求 auth 失败由 ModelsError 分类。 | `core/auth-guidance.ts:5-36` 给“Run /login”；`auth-check.ts:8-52` 区分 `not_ready`、`invalid`；login 失败在 TUI 单独呈现。 | `llm-deepseek/src/index.ts:412-431` 缺 key 为 `MISSING_CREDENTIAL`；README `:75-83,136-142` 记录格式校验、transport、401/协议错误，不泄露 key/原始响应。 | `login.rs:443-505` `status` 明确 `Logged in`/`Not logged in`/错误并使用退出码；`cli/doctor.rs:1329-1355` 给 remediation（重新 login 或 env）。 |
| 多 provider | provider 自带 `apiKey`/OAuth；`packages/ai/src/auth/types.ts` 的 `ProviderAuth`/`ApiKeyAuth` 是扩展边界，Pi 不把 provider 协议写死。 | `auth-flows.ts:89-103,247-280` 从 OAuth provider 和 model provider 构建分类列表，服务类 MCP 与模型 provider 分开。 | provider route、catalog、credential seam 分离；自定义 provider 只需引用 credential（`docs/user/guide/providers.md:17-29`）。 | `Config.model_providers` 和 `ModelProviderInfo`（`core/src/config/mod.rs:634-638,3709-3719`）支持多 provider；forced login policy 可限制方式。 |
| 平台差异 | auth provider 自己决定 OAuth；TUI 的核心 `/login` 仍跨平台，OS keychain 由宿主实现。 | `components/login-dialog.ts:174-185` 按 macOS `open`、Windows `rundll32`、Linux `xdg-open`，并保留手动 URL/输入（`:154-203,220-253`）。 | 本地 credential 文件在 POSIX 检查 mode，Windows 明确跳过 POSIX 位检查（`credentials-local/src/index.ts:114-145`）；Web/CLI 通过相同 seam。 | `login.rs:366-420` device/browser fallback；`auth/storage.rs:251-321,408-457` keyring backend + file fallback，平台能力由 backend 处理。 |
| 实现复杂度 | 中高：TUI、OAuth device/browser、锁定 auth store、catalog refresh；可复用 pi-ai。 | 高于 Pi：Prime splash、Prime CLI config、服务/MCP login、billing warning（`auth-flows.ts:105-195`）。 | 高：独立 credential/authorization seam、热加载、权限和引用解析；优点是 secret 不进入 settings。 | 高：OAuth/device-code、keyring/secrets backend、sandbox/permission/doctor；不适合作为 beta 的最小移植。 |
| 安全风险 | `auth.json` 是敏感文件；`docs/security.md:41-50` 要求隔离不可信仓库、最小化传入 credentials。`auth check --credentials` 可显式输出 secret，需宿主谨慎调用（`auth-command.ts:39-45`）。 | 文件 key、Prime CLI config、`!command`/models.json fallback 增加命令执行和 shadowing 风险；其 status API 只返回 source/label（`auth-storage.ts:56-68,538-555`）。 | credential seam 只传引用；`.credentials.yaml` owner-only、解析错误不回显 secret 行（`credentials-local/src/index.ts:114-145,178-197`），但 `.env` fallback 仍需信任工作区。 | keyring 优先、file fallback 的可用性与安全性权衡；login 日志只应记录目标/状态，不能记录 token（`cli/src/login.rs:48-107`、`login/src/auth/storage.rs:431-457`）。 |

### 参考实现边界与采用判断

- Pi：采用 provider-owned auth contract、环境变量优先级和 status/check 语义；拒绝直接复制
  Pi 的完整 OAuth/TUI/`auth.json` 体系，因 Nausicaa 尚无 credential store 边界。
- Prime：采用“首次 auth 检查 + 可取消 overlay + 模型选择分离”的交互思想；拒绝 Prime
  splash、Prime CLI 配置和服务/MCP 登录，它们不是 OpenRouter beta 的必要能力。
- DeepSeek：采用“settings 只存引用、按请求解析、错误分类且不回显 secret”的原则；拒绝
  Cordis 全局 runtime、`.credentials.yaml` provider 和 Web Models 页面移植。
- Codex：采用“非 TTY 明确失败/从 stdin 管道输入、状态命令只给安全摘要、OS keyring 可选”
  的原则；拒绝在本轮引入 OAuth/device-code、keyring backend 或 sandbox 登录策略。

## 2. Nausicaa 当前状态地图

| 入口 | 基线事实 | 证据 |
|---|---|---|
| 设置加载 | `loadSettings()` 只读取用户 `~/.nausicaa/settings.json`；信任 workspace 时再合并项目 `.nausicaa/settings.json`。允许字段集合没有 `apiKey`/credential。 | `src/config/settings.ts:115-205`；`test/unit/settings.test.ts:88-100` 写入 `apiKey` 会得到 `SettingsError`。 |
| 模型选择 | `resolveSettings()` 从 override（CLI `--model`）或 `NAUSICAA_MODEL` 得到 model；缺失直接抛 `SettingsError("No model configured. Pass --model or set NAUSICAA_MODEL.")`。没有默认付费模型。 | `src/config/settings.ts:157-205`；CLI override 组装 `src/cli.ts:116-133`。 |
| provider/auth | `PiAiModelPort` 是薄适配器，构造参数只有 `models`、provider 名和 fetch；注释明确 authentication 留在注入的 pi-ai provider collection。`createOpenRouterModelPort()` 只注册 OpenRouter provider。 | `src/model/pi-ai-model.ts:25-54,193-215`；`src/model/pi-ai-model.ts:205-223`。 |
| 实际请求 | Main/compaction 在 runtime 内直接 `deps.mainModel ?? createOpenRouterModelPort()`；没有注入 credential store、`Models.login`、`checkAuth` 或 keychain。pi-ai 的 auth 解析会在 `models.complete/stream` 边界执行。 | `src/runtime/run-runtime.ts:302-317,362-368`；`src/runtime/session-controller.ts:508-522`；上游调用点 `node_modules/@earendil-works/pi-ai/dist/models.js:275-291,358-385`。 |
| 首次 TTY | CLI 在读取设置前只检查是否 TTY；普通无参数启动进入 `runInteractive()`，没有 onboarding/auth selector。交互 autocomplete 只有 `/help`, `/status`, `/model`, `/permissions`, `/mode`, `/skills`, `/edges` 等，没有 `/login` 或 `/setup`。 | `src/cli.ts:80-89,197-247`；`src/cli/interactive.ts:247-309`。 |
| 非 TTY | 显式 `--print`/`--json` 可运行；普通模式无 TTY 立即返回 code 2。若 model 缺失，错误捕获最终按 `SettingsError` 返回 code 2；key 缺失目前通常要等 provider 请求才显现。 | `src/cli.ts:80-89,355-388`；`src/cli/args.ts:118-135`。 |
| key 来源/存储 | README 要求调用者 `export OPENROUTER_API_KEY`，并声明 key 只放当前进程环境；`.env.example` 只是示例。源码没有 `dotenv`、keychain、auth JSON 或登录命令。 | `README.md:73-90`；`.env.example:1-14`；`package.json` 无 dotenv/keyring 依赖；`rg` 对 `src/` 无 login/credential store 实现。 |
| 模型/TUI 状态 | `/model` 可以选择/切换 model；状态栏显示模型和权限，但没有 provider auth source 或掩码尾部。`modelCapabilities()` 是能力探测，不是 auth check，也不联网。 | `src/cli/interactive.ts:257-269`；`src/runtime/session-controller.ts:508-522`。 |
| 错误/脱敏 | `ProviderModelError` 只保留 category、HTTP status、safe usage；401/“api key/not configured”分类为 authentication，原始 provider body 不持久化。它仍是请求后的错误，不是启动前检查。 | `src/model/provider-error.ts:16-43`；`src/model/pi-ai-model.ts:470-500,535-543`；`test/unit/model-adapter.test.ts:634-652`。 |

因此，当前状态不能写成“pi-ai 已经给 Nausicaa 提供 onboarding”：pi-ai 有可复用的 auth API，
但 Nausicaa 没有把 `Models`/`CredentialStore` 暴露到 CLI/TUI，也没有调用 `login()`。

## 3. 推荐 beta UX（唯一最小方案）

### 设计原则

1. 首个 provider 是 OpenRouter，但不隐式选择会产生费用的模型；用户明确提供
   `--model openrouter:<id>` 或 `NAUSICAA_MODEL`。可在引导中预填当前 beta 建议值，必须确认后才使用。
2. TTY 首次缺配置显示一次可跳过的本地 panel；`Enter` 继续设置，`Esc`/`q` 跳过并进入空会话，
   `/setup` 可再次打开。引导只检查字符串、环境存在性和 provider/model catalog，不发请求。
3. beta 只读取 `OPENROUTER_API_KEY`（或未来 provider 声明的 env 名）并在进程内传给 pi-ai；
   不提示用户把 key 粘贴到 Nausicaa，不自动写 `.env`/settings，不实现 OAuth。
4. UI 只显示 `source=OPENROUTER_API_KEY` 和掩码尾部（例如 `••••abcd`）；没有 key 时显示
   `未配置`，无法从 UI 复制或恢复完整值。状态标记“未验证”，因为离线检查不证明 key 有效。
5. 非 TTY、CI 和脚本路径不等待输入。缺模型/缺 key 都在 provider 请求前退出 code 2，stderr
   包含可复制命令；`--json` 返回稳定的 `{code, provider, model, source}`，不含 secret。

### 用户旅程与关键文案

**A. 什么都没有（TTY）**

1. `nausicaa` 读取设置，发现 model 缺失；不创建 Run、不调用 provider。
2. 显示：

   > 还没有选择模型。OpenRouter 是当前 beta provider。按 Enter 设置模型，Esc 跳过；之后可用 `/setup` 返回。

3. 选择“设置模型”后输入 `openrouter:<model-id>`；确认后显示 provider/model 状态，再检查 env key。
4. 选择“跳过”进入 TUI，但提交普通消息前仍阻止请求并重复安全提示。

**B. model 已设置、key 缺失**

显示：

> 未检测到 `OPENROUTER_API_KEY`，不会发起模型请求。请在启动 Nausicaa 前运行：
> `export OPENROUTER_API_KEY='从 OpenRouter 控制台复制的 key'`
> 然后重新运行 `nausicaa --model <当前模型>`。Enter 跳过，Esc 返回模型设置。

这里的命令使用占位符，日志/截图/JSON 永远不能包含用户实际值。

**C. key 来自环境**

状态行：`OpenRouter · <model> · key: OPENROUTER_API_KEY (••••abcd) · 未验证`。
启动继续；key 只在当前 Node 进程和 pi-ai request auth 中存在。没有将 env 值写入 Run、Ledger、
Store、prompt、截图或普通错误。

**D. 用户取消**

Esc/q 关闭 panel，回到可用 TUI；不改变设置、不创建凭据、不发请求。`/setup` 再次进入；
非 TTY 没有等价的隐式交互，改用命令行环境变量。

**E. provider 返回无效 key/网络失败**

当前 `ProviderModelError` 的 authentication/network category 继续作为事实来源；UI 显示：
`OpenRouter 拒绝了当前凭据（HTTP 401）。检查 OPENROUTER_API_KEY 后重试。key 未被保存。`
网络错误显示 endpoint + `network`/`timeout` 类别和重试建议，不显示 provider 原始 body。退出 code
沿用现有错误约定（认证/配置 2，运行失败 1/3，最终由实现票据锁定并测试）。

**F. changing model later**

保留现有 `/model <selector>`/`--model`/`NAUSICAA_MODEL`。切换只更新 model 设置/当前 Session，
下一次请求重新检查对应 provider；若未来 provider 不是 OpenRouter，状态显示其声明的 env 名，
不把 OpenRouter 字段硬编码进通用 settings。

## 4. Secret/data-flow（beta）

```text
shell/CI secret
  OPENROUTER_API_KEY (process.env, read-only)
             |
             v
TTY/non-TTY local preflight -----------------------> safe status only
  (presence + provider/model + last-4 mask)          (source/mask, no value)
             |
             v
pi-ai provider auth resolver (per request)
  envApiKeyAuth -> Models.applyAuth -> request headers
             |
             v
        OpenRouter network

settings.json: model/capability fields only
Run/Ledger/Store/events/prompt/screenshots/logs: no key-bearing field
```

如果 env 变量为空、全空白或 provider 未知，preflight 返回未配置；不把“存在 env”当成有效
凭据，也不为验证而主动发网络请求。模型请求后的 `ProviderModelError` 只携带安全分类和
有限 usage，和 secret flow 分离。

## 5. 明确拒绝的方案

- **在项目目录自动写 `.env`**：容易被 git、压缩包、Skill/MCP 或不可信 workspace 带走；还会
  让 workspace 信任边界变成凭据写入边界。
- **把 key 放进 `settings.json`、Ledger、Store、prompt 或事件日志**：这些是配置/审计/上下文
  平面，不是 secret store；会扩大备份、截图和 Awareness 泄漏面。
- **本轮新建凭据数据库或跨平台 keychain abstraction**：迁移、锁、ACL、恢复和平台差异远超
  beta；后续应先采用成熟 provider-owned store，并作单独安全审查。
- **自研 OpenRouter OAuth、浏览器回调或 marketplace login**：provider 协议应由 `pi-ai` 维护；
  beta 只需 env key。
- **启动时强制网络验证 key 或刷新模型 catalog**：破坏离线/CI 可预测性，且会把“存在”误报为
  “有效”。真实验证留给用户明确提交后的 provider 请求。
- **非 TTY 复用 TUI 向导**：会在管道/CI 永久等待 stdin；Codex 的 stdin secret 也是显式子命令，
  不是普通启动隐式行为。
- **提供 `print-key` 或把 key 放进 `/status`**：状态只显示来源和掩码尾部；完整值永不进入 UI/API。

## 6. 后续施工票（最多三个）

### S1-ONB-1：本地配置/凭据 preflight 纯函数

- **文件边界**：新增 `src/cli/onboarding.ts`（或同 ownership 的小模块）；必要时在
  `src/cli.ts` 接一处调用；新增 `test/unit/onboarding.test.ts`。不改 provider 协议和持久化格式。
- **行为**：输入 resolved model、provider catalog、注入的 env view，输出 model/provider、env
  source、presence、masked tail、稳定错误 code；绝不输出原值，绝不 fetch。
- **离线验收**：无 model、空 env、env 存在、短 key、未知 provider、带 `--json` 的 redacted
  projection；断言 JSON/异常不含 sentinel key。
- **兼容/回滚**：默认只在启动前增加检查；删除该模块并移除一处调用即可回滚，不影响 Run 数据。

### S1-ONB-2：TTY `/setup` 可跳过 panel 与非 TTY 文案

- **文件边界**：`src/cli/interactive.ts`、必要的 `src/cli/selectors.ts`/TUI 小组件，及
  `test/unit/interactive*.test.ts` 或 smoke PTY fixture；不改 `settings` schema。
- **行为**：首次缺 model/key 显示一次 Enter/Esc panel；`/setup` 可重入；model 选择沿用现有
  selector；非 TTY code 2 + 可复制命令；状态只显示 source/mask。
- **离线验收**：PTY 首次、取消、重新进入、model set/key missing、env present；pipe/`--json`
  不读 stdin；截图/转录无完整 key。
- **兼容/回滚**：panel 是 presentation-only；移除调用即可恢复现有启动和 `/model` 行为。

### S1-ONB-3：薄 pi-ai auth/status 接线（beta env-only）

- **文件边界**：`src/model/pi-ai-model.ts` 和 `src/runtime/run-runtime.ts`/`session-controller.ts`
  的依赖注入处，另加 `test/unit/model-auth-preflight.test.ts`；不引入 credential DB、OAuth 或
  新依赖。
- **行为**：复用 `pi-ai` provider `checkAuth`/`getAuth` 能力（若 API 允许）但只传当前进程 env；
  在 request 前将“未配置”映射为本地配置错误；请求仍由 pi-ai 负责 auth/header。验证失败不写入
  Ledger/Store/prompt，错误保持 `ProviderModelError` 的安全分类。
- **离线验收**：注入 fake `Models`/`AuthContext`，断言 check 不 fetch、auth source 可投影、401/
  network 不泄露 body、Main/compaction 共用同一 provider seam。
- **兼容/回滚**：保留 `PiAiModelPort` 构造的现有 `models` 注入；任何接线失败可退回请求后错误，
  不迁移已有 Run/设置。

### 后续扩展（不属于今晚施工）

在 beta 稳定后另立安全审查：实现 `pi-ai Models.login/logout` 的宿主 adapter，优先 OS keychain，
无 keychain 时明确用户选择的 owner-only 文件 fallback；增加 provider status、迁移、锁和恢复测试。
该扩展不能改变 settings JSON、Ledger、Store 或 prompt 的 secret 禁止规则，也不能把 provider 登录
协议复制到 Nausicaa。

## 当前状态、推荐下一步与未决产品选择

- **当前状态**：研究完成；运行时仍无 onboarding/login/keychain；环境变量和模型设置路径保持原样。
- **推荐下一步**：先做 S1-ONB-1 的纯离线 preflight，再做 S1-ONB-2 TTY/非 TTY UX，最后才评估
  S1-ONB-3 是否能在不引入存储的前提下复用 pi-ai auth。每票独立可回滚。
- **估计改动面**：约 1 个纯函数模块、1 个 TUI 接线点、1 个 model 依赖注入点和聚焦测试；不改
  settings schema、Ledger、Store、package 依赖或 provider wire。
- **仍需产品决策**：是否允许 beta 预填但不默认提交 `openrouter:tencent/hy3`；未验证状态是否
  允许用户直接发送首条请求；认证/配置错误最终退出码是否统一为 2；后续 OS keychain 的支持平台
  与文件 fallback 策略。以上不应在本研究报告中擅自决定。

