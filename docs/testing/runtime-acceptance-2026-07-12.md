# 专用 runtime 验收记录（2026-07-12）

环境：OpenClaw 2026.6.11；`panel-claude-runtime` 与 `panel-main-runtime` 均为 0 bindings，sessions 根与真实 agent 隔离。每项仅调用一次随机无匹配 nonce 的 `memory_search`；没有调用 browser/canvas、文件、shell、网络或消息工具。

| 项目 | panel-claude-runtime | panel-main-runtime |
|---|---:|---:|
| workspace 受限快照文件数 | 8 | 6 |
| 验收前后 hash 一致 | 是 | 是 |
| AGENTS/TOOLS/SOUL/USER/MEMORY 注入证据 | 5/5 | 0/5 |
| skills 数量 | 22 | 22 |
| skill 名列表 SHA-256 | `dcb55444346e93dca8aee19cebd839fef4e9dcf9fecbfd7b256723659421b74c` | 同左 |
| memory_search 工具存在并调用 | 是 | 是 |
| 随机 nonce 报告结果数 | 0 | 0 |
| browser/canvas 工具存在 | 是 | 是 |
| browser/canvas 主动调用 | 跳过 | 跳过 |

结果：`panel-claude-runtime` 通过。`panel-main-runtime` 不通过 bootstrap 注入项；复跑并允许 `AGENTS`/`AGENTS.md` 两种白名单形式后仍为 0/5。磁盘只读检查显示 main workspace 中 AGENTS、TOOLS、SOUL、USER 存在，MEMORY 不存在，但“文件存在”不能替代“已注入模型系统上下文”的证据，因此不猜测为通过。

两次验收后两个 runtime 均为 0 sessions，目录仅剩 `sessions.json`。memory recall 的可识别 tool call/result 曾写入一次性 transcript/trajectory，清理后不存在；受限 workspace 快照未变化。没有足够证据判断 OpenClaw 是否还在共享内部状态中记录 recall 统计，因此该项记为“未确认”，而不是“无落盘”。
