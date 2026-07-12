import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeService } from "../src/gateway/bridge-service.js";
import type { BridgeMaterializer, CreatedSession, GatewayClient } from "../src/gateway/adapter.js";

test("bridge 成功和失败都先注销并清理", async () => {
  for (const fail of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "bridge-service-")); const id = "11111111-1111-4111-8111-111111111111";
    const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:key", transcriptPath: join(root, `${id}.jsonl`) };
    await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
    const events: string[] = [];
    const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { events.push("create"); return created; },
      async send() { events.push("send"); return { runId: "run" }; }, async waitForCompletion() { events.push("wait"); if (fail) throw new Error("failed"); },
      async abort() { events.push("abort"); }, async deleteSession() { events.push("delete"); } };
    const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { return 0; }, async readNewEntries() { return [{ type: "message" }]; },
      verifyAndStripSubmittedUser(entries) { return entries; } };
    const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
    const call = service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "虚构", latestUserEntryId: "panel-user", idempotencyKey: "same" });
    if (fail) await assert.rejects(call, /failed/); else await call;
    assert.equal(events.at(-1), "delete");
    if (fail) assert.ok(events.includes("abort"));
  }
});

test("连续 20 轮 fixture 生成后无 transcript/trajectory artifact 累积", async t => {
  const root=await mkdtemp(join(tmpdir(),"bridge-durability-"));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,"sessions.json"),"{}");let sequence=0;
  const client:GatewayClient={async version(){return"2026.6.11"},async createSession(){sequence++;const id=`00000000-0000-4000-8000-${String(sequence).padStart(12,"0")}`;const transcriptPath=join(root,`${id}.jsonl`);await writeFile(transcriptPath,"fixture\n");await writeFile(join(root,`${id}.trajectory.jsonl`),"trajectory\n");await writeFile(join(root,`${id}.trajectory-path.json`),"{}\n");return{sessionId:id,sessionKey:`agent:runtime:${id}`,transcriptPath}},async send(){return{runId:`run-${sequence}`}},async waitForCompletion(){},async abort(){},async deleteSession(sessionKey){const id=sessionKey.split(":").at(-1)!;await writeFile(join(root,`${id}.jsonl.deleted.fixture`),await readFile(join(root,`${id}.jsonl`)));await import("node:fs/promises").then(fs=>fs.rm(join(root,`${id}.jsonl`)));await writeFile(join(root,"sessions.json"),"{}")}};
  const materializer:BridgeMaterializer={async replaceCreatedTranscript(){return 0},async readNewEntries(){return[{type:"message",message:{role:"user",content:"fixture"}},{type:"message",message:{role:"assistant",content:"ok"}}]},verifyAndStripSubmittedUser(entries){return entries.slice(1)}};
  const service=new BridgeService(client,materializer,new Map([["runtime",root]]));
  for(let i=0;i<20;i++){const result=await service.generate({runtimeAgentId:"runtime",historyThroughPreviousRun:{header:{type:"session"},entries:[]},latestUserMessage:"fixture",latestUserEntryId:`u${i}`,idempotencyKey:`k${i}`});assert.equal(result.entries.length,1)}
  assert.deepEqual(await readdir(root),["sessions.json"]);assert.equal(await readFile(join(root,"sessions.json"),"utf8"),"{}");
});

test("bridge 在发送前把会话 override 以 patch 应用到临时 session", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-overrides-"));
  const id = "22222222-2222-4222-8222-222222222222";
  const created: CreatedSession = { sessionId: id, sessionKey: "agent:runtime:key", transcriptPath: join(root, `${id}.jsonl`) };
  await writeFile(join(root, `${id}.jsonl.deleted.fixture`), "x");
  const events: string[] = [];
  const client: GatewayClient = { async version() { return "2026.6.11"; }, async createSession() { events.push("create"); return created; },
    async applySessionOverrides(key, overrides) { assert.equal(key, created.sessionKey); assert.deepEqual(overrides, { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" }); events.push("patch"); },
    async send() { events.push("send"); return { runId: "run" }; }, async waitForCompletion() {}, async abort() {}, async deleteSession() { events.push("delete"); } };
  const materializer: BridgeMaterializer = { async replaceCreatedTranscript() { events.push("materialize"); return 0; }, async readNewEntries() { return []; }, verifyAndStripSubmittedUser(entries) { return entries; } };
  const service = new BridgeService(client, materializer, new Map([["runtime", root]]));
  await service.generate({ runtimeAgentId: "runtime", historyThroughPreviousRun: { header: { type: "session" }, entries: [] }, latestUserMessage: "hello", latestUserEntryId: "user", idempotencyKey: "key",
    overrides: { modelOverride: "provider/model", thinkingLevel: "high", reasoningLevel: "stream" } });
  assert.deepEqual(events.slice(0, 4), ["create", "materialize", "patch", "send"]);
});
