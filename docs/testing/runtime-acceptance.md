# 专用 runtime 兼容性验收

该验收只允许 `panel-claude-runtime`、`panel-main-runtime` 或 `paneltest`，并要求 runtime 在 `openclaw.json` 中没有任何 binding。脚本使用一次性 session，完成后按受限 artifact 清理流程注销和删除。

```sh
npm run test:runtime-acceptance -- panel-claude-runtime panel-main-runtime
```

每个 runtime 只发一次受控请求：以随机、预期无匹配的 nonce 调用 `memory_search`，随后自行列出系统提示中可见的 bootstrap 文档名、skill 名称和结果计数。prompt 不提供 bootstrap 文件名，避免把问题中的名字误当成注入证据；输出再经过本地固定白名单。脚本不打印文件、记忆或工具结果正文；只输出 workspace 受限快照的 hash/文件数、工具存在性和脱敏报告。

安全边界：

- 运行前强制确认 OpenClaw 版本为 `2026.6.11`、零 bindings、专用 sessions 根。
- 请求明确禁止其它工具、文件读写和网络访问。
- `browser` / `canvas` 只从编译后的工具列表确认存在性，不主动调用，因为启动浏览器或 canvas 是否写状态无法在通用环境中证明无副作用。
- 快照只覆盖 `AGENTS.md`、`TOOLS.md`、`SOUL.md`、`USER.md`、`MEMORY.md` 与 `memory/`；前后 hash 必须一致。
- `memory_search` 的可识别调用轨迹只存在于一次性 transcript/trajectory，验收后随 session artifact 清理。是否另有 OpenClaw 内部 recall 持久化只能报告观测结果，不能据此声称不存在。
- 若 runtime 有 binding、目录不安全、报告包含非白名单字段或 workspace hash 改变，应视为失败并停止后续项。
- `passed` 只有在五类 bootstrap 均得到正面注入证据、skills 非空、三个目标工具均存在、`memory_search` 确实调用且 workspace hash 不变时才为 true；任一 runtime 不通过时 CLI 以非零状态退出。
