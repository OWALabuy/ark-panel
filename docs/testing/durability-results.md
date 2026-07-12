# 面板异常恢复与耐久验收记录

日期：2026-07-12

本轮只使用内存/临时目录 fixture，没有调用真实模型、真实 agent、IM 或 gateway，也没有重启 gateway。

## 自动验收结果

- HTTP/SSE 客户端在 `run.started` 后断开：服务端对应 `AbortSignal` 被触发，生成层收到 `BRIDGE_ABORTED`，不会伪报完成。
- bridge / generation abort 或失败：panel 权威 transcript 不追加本轮 user，也不出现半个 run。
- 失败后的同一幂等 key：失败不进入 completed cache，可以原消息原 key 安全重试；成功后只提交一组 user + assistant。
- 连续 20 轮 bridge fixture：每轮模拟 transcript、deleted transcript、trajectory 和 trajectory pointer；每轮均先官方注销语义，再由受限清理删除。最终 runtime 根只有 `sessions.json`，内容为 `{}`。
- 20 轮结果逐轮检查只返回完整 assistant entry；transcript 解析器现有测试继续拒绝半行 JSON。
- 新增的耐久/恢复测试均注册临时 dataRoot 清理。
- 生产部署 dry-run 已实际 spawn 面板进程并用 SIGTERM 验证退出码 0、重启后数据仍可读、backup/restore 后仍可启动读取，且进程和临时目录无残留。

全套测试 48 项通过，TypeScript 类型检查通过。

## 未做真实调用的原因

20 轮清理、断线和幂等语义可以由确定性 fixture 完整覆盖；使用真实模型不会增加文件边界或提交事务方面的证明力，只会增加成本和外部不确定性。此前 `paneltest` 与 `panel-claude-runtime` 已分别完成过真实 bridge 单轮验收，因此本轮没有重复模型调用。

## 明确未实测

- gateway 进程重启：会影响用户当前服务，按约束禁止实际执行。现有测试只覆盖客户端失败、abort、进程退出和清理代码路径，不能宣称 gateway 重启恢复已经通过。
- 面板在真实 gateway run 正进行时收到 SIGTERM：本轮只验证了 HTTP 断线触发 abort、生成层 abort 不提交，以及面板进程的正常 SIGTERM/重启持久性，没有将三者与真实模型调用组合测试。若以后要做，只应使用无渠道 runtime，并先明确 SIGTERM 时等待 gateway abort/清理的最大时限。
- 网络分区后 gateway 已完成、面板尚未搬运 entries 的自动追单：当前架构会把 panel transcript 保持在旧的完整状态，并清理一次性 session；它不会留下半 run，但也没有持久 run journal 用于重启后补领结果。

这些未实测项不影响“失败不破坏 panel 权威 transcript”的结论，但属于未来若要求自动恢复已完成回复时需要补的 run journal / recovery 设计。
