#!/usr/bin/env bash
set -euo pipefail

# 第 0 段桥接实验的最小复现。只允许对 paneltest 运行。
# 依赖：openclaw 2026.6.11、jq、已运行且使用固定 token 的本机 gateway。

agent=paneltest
key="panelbridge-repro-$(date +%s)"
canonical="agent:${agent}:${key}"
sessions_dir="$HOME/.openclaw/agents/$agent/sessions"
workspace="$HOME/paneltest-workspace"

if jq -e --arg agent "$agent" '.bindings[]? | select(.agentId == $agent)' \
  "$HOME/.openclaw/openclaw.json" >/dev/null; then
  echo "拒绝运行：paneltest 存在渠道绑定" >&2
  exit 1
fi

if ! jq -e '.gateway.auth.token | type == "string" and length > 0' \
  "$HOME/.openclaw/openclaw.json" >/dev/null; then
  echo "拒绝运行：gateway 没有固定 token" >&2
  exit 1
fi

openclaw gateway call sessions.create --json --params \
  "{\"key\":\"$key\",\"agentId\":\"$agent\",\"label\":\"bridge repro\"}" >/dev/null

session_id="$(openclaw sessions --agent "$agent" --json | \
  jq -r --arg key "$canonical" '.sessions[] | select(.key == $key) | .sessionId')"
transcript="$sessions_dir/$session_id.jsonl"

# sessions.create 先合法登记；随后才物化面板历史。绝不写 sessions.json。
jq -nc --arg id "$session_id" --arg cwd "$workspace" \
  '{type:"session",version:3,id:$id,timestamp:"2026-07-11T00:00:00.000Z",cwd:$cwd}' >"$transcript"
jq -nc '{type:"message",id:"seed-user",parentId:null,timestamp:"2026-07-11T00:00:01.000Z",message:{role:"user",content:[{type:"text",text:"虚构口令是：桥接测试八号。"}],timestamp:1783728001000}}' >>"$transcript"
jq -nc '{type:"message",id:"seed-assistant",parentId:"seed-user",timestamp:"2026-07-11T00:00:02.000Z",message:{role:"assistant",content:[{type:"text",text:"明白。"}],api:"openai-completions",provider:"mini1",model:"claude-opus-4-8",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0},stopReason:"stop",timestamp:1783728002000}}' >>"$transcript"

before_lines="$(wc -l <"$transcript")"
run_id="$(cat /proc/sys/kernel/random/uuid)"
openclaw gateway call sessions.send --json --params \
  "{\"key\":\"$canonical\",\"agentId\":\"$agent\",\"message\":\"只回答先前约定的虚构口令，不使用工具。\",\"timeoutMs\":90000,\"idempotencyKey\":\"$run_id\"}" >/dev/null

for _ in $(seq 1 60); do
  status="$(openclaw gateway call sessions.describe --json --params \
    "{\"key\":\"$canonical\"}" 2>/dev/null | jq -r '.session.status // empty')"
  [[ "$status" == done || "$status" == failed || "$status" == killed ]] && break
  sleep 1
done

echo "status=$status session_id=$session_id before_lines=$before_lines after_lines=$(wc -l <"$transcript")"
tail -n "+$((before_lines + 1))" "$transcript" | jq -c .

# 注意：deleteTranscript=true 会归档 transcript，并不会清理 trajectory 文件。
openclaw gateway call sessions.delete --json --params \
  "{\"key\":\"$canonical\",\"agentId\":\"$agent\",\"deleteTranscript\":true,\"emitLifecycleHooks\":false}"
