# Fixture 生命周期稳定性验收记录（2026-08-13）

> **日期化证据元数据**
>
> - Date: `2026-08-13`
> - ark-panel implementation commit: `9663899`
> - Node.js: `22.22.0`（Linux）
> - OpenClaw version: 不适用（完全本地、虚构的确定性 fixture）
> - Status: `historical pass`；仓库内 runner 为 `current automated`
> - Superseded/current applicability: 结果只证明上述实现快照和下列精确测试集合；后续
>   修改这些测试、helper 或对应实现后必须重跑。可重复的当前命令与状态见
>   [acceptance matrix](README.md)。

本轮关闭 #41 的重复验收范围。没有连接真实 OpenClaw、Gateway、模型或用户目录，
也没有运行 browser fixture。

## 命令与精确范围

先执行一次构建，再由 runner 在默认并发和 `--test-concurrency=1` 两种模式下各执行
20 轮：

```sh
npm run build
node scripts/test-fixture-lifecycle.mjs --runs 20
```

runner 只接受以下四个已编译测试文件，启动前逐个确认其存在且为非符号链接的普通
文件：

- `dist/test/stream-client.test.js`
- `dist/test/cli-client.test.js`
- `dist/test/generation-api.test.js`
- `dist/test/bridge-service.test.js`

每轮使用新的隔离 `TMPDIR`。runner 创建 root 后保存其 device/inode identity；测试
子进程退出后再次执行 `lstat` 并精确匹配 identity，再用 `readdir` 要求条目数为 0，
然后删除 root 并用 `lstat` 确认 `ENOENT`。identity 不匹配时只失败而不删除替换路径。
每轮还注入唯一 fixture 签名并建立独立进程组；Linux `/proc` 检查只观察该独立组内
的 PID，且只读取这些组成员的签名，不扫描命令正文、不输出路径，也不操作其它用户进程。
非零退出、超时、TAP 汇总不一致、root 条目或 owned PID 残留都会立即使 runner
失败。测试超时后只向直接子进程发送有界终止信号；独立的 close deadline 防止继承
pipe 的后代令 runner 无限等待，deadline 到期与任何组内残留都只报告失败，不通过
进程组清理制造通过结果。root 的 device/inode 检查与删除位于统一的 finally 路径，
因此 spawn 前或 owned-process 扫描失败也不会跳过安全清理；主错误与清理错误同时出现
时保留双因果。

## 结果

运行前的单轮基线在两种模式下均为 92/92 通过，隔离 root 条目为 0。正式结果如下：

| 模式 | 轮数 | 每轮测试数 | 退出码 | 总耗时 | 单轮范围 | roots 创建/删除 | root 残留条目 | owned process 残留 |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 默认并发 | 20 | 92 | 全部 0 | 79,710 ms | 3,758–4,460 ms | 20/20 | 0 | 0 |
| `--test-concurrency=1` | 20 | 92 | 全部 0 | 114,901 ms | 5,515–6,213 ms | 20/20 | 0 | 0 |

合计 40 轮、3,680 个测试结果和 40 个独立 root；未观察到 flake、runner timeout、
fixture 文件残留或 owned child 残留。所有测试子进程均正常退出，没有观察到 server、
watcher 或 referenced timer 导致测试子进程无法退出。本结果只覆盖上述四个确定性
fixture 文件；它不证明真实 Gateway/runtime 行为，也不替代后续 CI 或完整套件结果。

正式重复验收在以 `9663899` 为基线、包含尚未提交 runner 的工作树上执行。日期化文档
写入后，runner 通过 `node --check`、bounded-close、root replacement 和 pre-spawn
failure 三项 fault self-test，并以 `--runs 2` 重跑两种模式：
默认并发总耗时 7,612 ms、串行总耗时 11,472 ms，两者仍为每轮 92/92、退出码 0、
root 残留 0、owned process 残留 0。最后执行 `npm test`，完整套件 401/401 通过，
绝对耗时 10,241 ms；该单次绝对值不用于声称相对性能改善或无回退。
