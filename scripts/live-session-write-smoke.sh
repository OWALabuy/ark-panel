#!/usr/bin/env bash
set -euo pipefail

# Destructive integration acceptance: intentionally requires an exact phrase plus
# explicit keys/ids so it can never silently select a real conversation.
[[ "${PANEL_LIVE_WRITE_CONFIRMATION:-}" == "I_ACKNOWLEDGE_TWO_REAL_SESSION_WRITES" ]] || {
  echo "refusing live write: set PANEL_LIVE_WRITE_CONFIRMATION exactly" >&2; exit 2;
}
for name in CLAUDE_LIVE_KEY CLAUDE_LIVE_SESSION_ID MAIN_LIVE_KEY MAIN_LIVE_SESSION_ID; do
  [[ -n "${!name:-}" ]] || { echo "missing $name" >&2; exit 2; }
done
[[ "$(openclaw --version)" == OpenClaw\ 2026.6.11* ]] || { echo "unsupported OpenClaw version" >&2; exit 2; }

describe() { openclaw gateway call sessions.describe --json --params "{\"key\":\"$1\"}"; }
preflight() {
  local agent="$1" key="$2" id="$3" result
  result="$(describe "$key")"
  [[ "$(jq -r '.session.sessionId' <<<"$result")" == "$id" ]] || { echo "$agent sessionId changed" >&2; exit 2; }
  [[ "$(jq -r '.session.status' <<<"$result")" == "done" ]] || { echo "$agent session is not done" >&2; exit 2; }
  [[ "$(jq -r '.session.chatType' <<<"$result")" == "direct" ]] || { echo "$agent target is not direct chat" >&2; exit 2; }
  [[ "$(jq -r '.session.deliveryContext != null' <<<"$result")" == "true" ]] || { echo "$agent lacks delivery context" >&2; exit 2; }
  [[ "$key" == "agent:$agent:"* ]] || { echo "$agent key mismatch" >&2; exit 2; }
  local transcript="$HOME/.openclaw/agents/$agent/sessions/$id.jsonl"
  [[ -f "$transcript" && ! -L "$transcript" ]] || { echo "$agent transcript unsafe" >&2; exit 2; }
}

# Both targets must pass before the first write.
preflight claude "$CLAUDE_LIVE_KEY" "$CLAUDE_LIVE_SESSION_ID"
preflight main "$MAIN_LIVE_KEY" "$MAIN_LIVE_SESSION_ID"

send_one() {
  local agent="$1" key="$2" id="$3" expected="[ark-panel验收] ${agent^^}_LIVE_WRITE_OK" transcript before response run_id
  transcript="$HOME/.openclaw/agents/$agent/sessions/$id.jsonl"; before="$(wc -l <"$transcript")"
  response="$(openclaw gateway call sessions.send --json --params "$(jq -cn --arg key "$key" --arg agent "$agent" --arg message "[ark-panel验收] 真实活会话写入测试。不要调用任何工具，不要读取或提及隐私、记忆、文件或工作区内容；只回复固定短语：$expected" --arg idem "$(node -e 'console.log(crypto.randomUUID())')" '{key:$key,agentId:$agent,message:$message,timeoutMs:90000,idempotencyKey:$idem}')")"
  run_id="$(jq -r '.runId' <<<"$response")"; [[ -n "$run_id" && "$run_id" != null ]] || { echo "$agent send did not start" >&2; exit 1; }
  for _ in {1..180}; do
    status="$(describe "$key" | jq -r '.session.status')"; [[ "$status" == done ]] && break; [[ "$status" == failed ]] && { echo "$agent run failed" >&2; exit 1; }; sleep 0.5
  done
  [[ "$(describe "$key" | jq -r '.session.status')" == done ]] || { echo "$agent run timeout" >&2; exit 1; }
  tail -n "+$((before + 1))" "$transcript" | jq -e --arg expected "$expected" 'select(.type=="message" and .message.role=="assistant") | [.message.content[]? | select(.type=="text") | .text] | join("") | contains($expected)' >/dev/null
  echo "$agent accepted; channel=$(describe "$key" | jq -r '.session.lastChannel // "unknown"')"
}

send_one claude "$CLAUDE_LIVE_KEY" "$CLAUDE_LIVE_SESSION_ID"
send_one main "$MAIN_LIVE_KEY" "$MAIN_LIVE_SESSION_ID"
