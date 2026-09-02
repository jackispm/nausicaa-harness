# Upstream Live Test Inventory

审计日期：2026-09-03

本文把 Pi、Prime Agent、DeepSeek Harness 和 Codex 的真实模型/联网测试
按可移植性收拢。它是来源清单，不是把上游的全部测试都宣称为
Nausicaa 的能力题。源代码快照仍保存在各自本地 checkout；每个被采用的
题目在 beta manifest 中记录了 revision、许可证和采用/排除边界。

## 判定规则

- `workflow-live`：真实模型选择工具、读取或修改一个临时工作区，结果由
  host 在模型退出后检查。
- `provider-live`：验证 provider 适配器的流式、usage、图片、缓存或错误
  映射；它不能代表通用工具能力。
- `protocol-ui-only`：验证 RPC、ACP、daemon、浏览器回放或专用 wire；它
  只有在对应 host contract 公开后才适合单独设 gate。

## 已移植的 workflow-live 题目

| 来源 | 上游测试族 | Nausicaa case |
| --- | --- | --- |
| Pi | eval smoke、extension eval、bounded read、独立批量读取、disjoint edit、large output、path discovery、structured path operation | `pi-smoke`、`pi-extension`、`pi-read-window`、`pi-parallel-tools`、`pi-edit-disjoint`、`pi-bash-tail`、`pi-find-scope`、`pi-delete-action` |
| DeepSeek Harness | headless coding、bash round trip、exact rewrite、resume、filesystem cwd、workspace instructions、compaction、in-process subagent、capability denial | `bugfix`、`bash-roundtrip`、`file-rewrite`、`resume`、`deepseek-fs-cwd`、`deepseek-instructions`、`fukai-compaction`、`multi-agent`、`permission-boundary` |
| Pi + DeepSeek | grounded README probe and independent evidence synthesis | `compatibility`、`incident-triage` |

这些 19 道题构成当前统一 beta capability catalog。每题都使用临时、虚构
的 fixture，grader 在模型之外检查世界状态、工具轨迹、答案格式和边界。

## 可借鉴但暂不纳入普通能力分数

| 来源 | 测试族 | 原因 |
| --- | --- | --- |
| Prime / Pi | session tree、branch summary、RPC attach、queue/steering | 需要分支或远程提交的公开 host contract；现有离线协议测试已覆盖基础边界 |
| Prime / DeepSeek | daemon restart、worker thread、cross-run bus、awareness topology | 这是独立 daemon/A2A gate，不应和单 Run 模型质量混在一起 |
| DeepSeek | todo、code mode、ACP escalation、hook、workflow thread | 依赖尚未作为 Nausicaa 公共 capability 暴露的执行环境或协议 |
| DeepSeek | native adapter、pi-ai adapter、cache、vision、web search | provider/integration probe；需要相应账号、端点或文件上传能力 |
| DeepSeek | E2B、Exa、Perplexity、Azure/Anthropic | 外部服务或供应商专属；可做可选 integration suite，不能作为核心分数 |
| Codex | account/OAuth、native permission wire | 账户或私有协议检查，不是 provider-neutral workflow |
| Pi / Prime / DeepSeek | browser record/replay、DOM、截图、ACP framing | presentation/transport 合同，不代表模型能否完成工作 |

## 公开来源清单

上游 live 审计的详细路径和采用理由：

- DeepSeek：`/private/tmp/deepseek-live-inventory.md`
- Prime/Pi：`/private/tmp/prime-portable-gap-audit.md`
- Pi 测试文件索引：`/private/tmp/pi-audit-files.txt`

这些路径是本机研究材料，不会进入 npm 包，也不包含凭据。仓库内的
`upstream-live-task-matrix.md` 和本页是发布时可读的摘要。

## 收口结论

“全部移植”在这里指所有能在当前 Nausicaa host contract 中表达、且能由
真实模型完成的 workflow-live 题目；不是复制上游与其 provider、浏览器或
Python 执行环境绑定的每个测试文件。新增能力公开后，再把相应独立 gate
加入 catalog，并保持 manifest/scorer revision 可追溯。
