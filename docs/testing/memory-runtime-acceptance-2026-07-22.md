# 记忆整理 runtime 验收记录（2026-07-22）

环境：OpenClaw 2026.6.11。`panel-memory-claude` 与 `panel-memory-main` 均使用独立 agent/session 目录、零渠道 binding，并与对应普通面板 runtime 共享 workspace。两者的 per-agent 工具 allowlist 仅包含 `memory_search` 与 `memory_get`。

## 验收中发现并修复的问题

OpenClaw 的 `tools.catalog` 返回已注册工具全集，不应用 per-agent policy；它不能证明临时 session 的实际权限。面板原实现因此会把安全的记忆 runtime 错判为含副作用工具。

修复后，面板在一次性 session 创建后、发送模型请求前调用 `tools.effective`，并只接受实际有效工具集合为空或严格属于 `memory_search` / `memory_get` 的 session。该检查与真正生成候选使用同一个 session identity；检查失败时 bridge 在模型请求前终止并清理。

## 隔离写入闭环

先临时收窄既有 `paneltest` 的工具策略，在其隔离 workspace 中执行完整流程，结束后恢复原策略：

| 项目 | 结果 |
|---|---:|
| 临时 session 的实际有效工具 | `memory_get`、`memory_search` |
| 真实模型生成候选 | 通过 |
| 候选阶段 workspace hash 不变 | 是 |
| 来源 transcript 逐字不变 | 是 |
| 确认文件名符合唯一 batch 格式 | 是 |
| 落盘内容与候选 hash/正文一致 | 是 |
| ledger/checkpoint 在文件完成后推进 | 是 |
| 删除验收文件后 workspace hash 恢复 | 是 |
| 临时 transcript/trajectory 清理 | 是 |

验收只使用虚构的产品决定，不读取或输出真实记忆正文。确认文件写在测试 workspace，核验后立即删除；候选与 ledger 使用临时面板数据目录并在结束后清理。

## 已配置 runtime 候选生成

随后分别通过 `panel-memory-claude` 和 `panel-memory-main` 运行一次虚构来源的候选生成，不执行确认写入：

| 项目 | panel-memory-claude | panel-memory-main |
|---|---:|---:|
| 实际有效工具严格为两个记忆工具 | 是 | 是 |
| 真实模型生成非空 Markdown 候选 | 是 | 是 |
| 候选前后受限 workspace hash 一致 | 是 | 是 |
| registry 中无临时 session | 是 | 是 |
| transcript/trajectory artifact 残留 | 无 | 无 |
| 渠道 binding | 0 | 0 |

OpenClaw 会在各 runtime 的 session 目录保留内容寻址的 `skills-prompts` 缓存；它不属于会话 transcript/trajectory，也不包含本次虚构来源或模型候选。两边的 `sessions.json` 在验收结束后均为 0 条记录。

结果：手动记忆整理的权限预检、候选、确认、durability、checkpoint 和清理边界通过当前受支持版本的隔离实机验收。该结论只适用于 OpenClaw 2026.6.11 和本次配置；升级版本或调整工具策略后必须重新验收。
