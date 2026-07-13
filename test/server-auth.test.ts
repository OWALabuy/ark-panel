import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { passwordHash } from "../src/server/auth.js";
import { createPanelServer, type CommandApi, type ReadApi } from "../src/server/app.js";
import { ContextBudgetExceededError } from "../src/domain/context-budget.js";
import { ForkError } from "../src/domain/fork.js";

async function fixture(generation?: { generate(recordId: string, message: string, signal: AbortSignal, runId: string): Promise<{ runId: string; entries: unknown[] }> }, reads?: ReadApi, commands?: CommandApi) {
  const publicDir = await mkdtemp(join(tmpdir(), "panel-web-")); await writeFile(join(publicDir, "index.html"), "ok");
  const server = createPanelServer({ auth: { username: "owl", passwordHash: passwordHash("correct", "0011223344556677"), sessionSecret: "test-secret-long-enough" }, publicDir, mock: reads ? false : true, ...(generation ? { generation } : {}), ...(reads ? { reads } : {}), ...(commands ? { commands } : {}) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}
test("API rejects unauthenticated requests", async t => { const x = await fixture(); t.after(()=>x.server.close()); const r = await fetch(`${x.base}/api/v1/agents`); assert.equal(r.status, 401); });
test("non-mock reads are delegated without connecting a real agent", async t => {
  const reads:ReadApi={async agents(){return [{id:"safe"}]},async sessions(agentId){assert.equal(agentId,"safe");return [{recordId:"record"}]},async conversation(recordId){assert.equal(recordId,"record");return {title:"safe"}}}; const x=await fixture(undefined,reads);t.after(()=>x.server.close());
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});const cookies=login.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; ");
  assert.deepEqual((await (await fetch(`${x.base}/api/v1/agents`,{headers:{cookie:cookies}})).json()).data,[{id:"safe"}]); assert.deepEqual((await (await fetch(`${x.base}/api/v1/sessions?agentId=safe`,{headers:{cookie:cookies}})).json()).data,[{recordId:"record"}]); assert.deepEqual((await (await fetch(`${x.base}/api/v1/sessions/record`,{headers:{cookie:cookies}})).json()).data,{title:"safe"});
});
test("Markdown 导出需要登录并使用安全附件响应", async t => {
  const reads: ReadApi = { async agents(){return[]}, async sessions(){return[]}, async conversation(){return null}, async exportMarkdown(recordId){assert.equal(recordId,"record");return{filename:"中文标题.md",markdown:"# safe\n"}} };
  const x=await fixture(undefined,reads);t.after(()=>x.server.close());assert.equal((await fetch(`${x.base}/api/v1/sessions/record/export.md`)).status,401);
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});const cookies=login.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; ");
  const response=await fetch(`${x.base}/api/v1/sessions/record/export.md`,{headers:{cookie:cookies}});assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"text/markdown; charset=utf-8");assert.match(response.headers.get("content-disposition")||"",/^attachment;/);assert.match(response.headers.get("content-disposition")||"",/filename\*=UTF-8''/);assert.equal(await response.text(),"# safe\n");
});
test("active/reset sources are rejected before generation",async t=>{let calls=0;const reads:ReadApi={async agents(){return[]},async sessions(){return[]},async conversation(){return{sourceKind:"active"}}};const x=await fixture({async generate(_record,_message,_signal,runId){calls++;return{runId,entries:[]}}},reads);t.after(()=>x.server.close());const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});const body=await login.json()as{data:{csrfToken:string}};const cookies=login.headers.getSetCookie().map(value=>value.split(";",1)[0]).join("; ");const response=await fetch(`${x.base}/api/v1/sessions/active/messages`,{method:"POST",headers:{cookie:cookies,origin:x.base,"x-csrf-token":body.data.csrfToken,"content-type":"application/json"},body:JSON.stringify({message:"must not run"})});assert.equal(response.status,409);assert.equal((await response.json()).error.code,"SOURCE_READ_ONLY");assert.equal(calls,0)});
test("login issues hardened cookies and permits reads", async t => {
  const x = await fixture(); t.after(()=>x.server.close());
  const login = await fetch(`${x.base}/api/v1/auth/login`, { method: "POST", headers: { origin: x.base, "content-type":"application/json" }, body: JSON.stringify({ username:"owl", password:"correct" }) });
  assert.equal(login.status, 200); const value = await login.json() as { data: { csrfToken: string } }; const setCookies = login.headers.getSetCookie();
  assert.ok(setCookies.some(v=>v.includes("panel_session=") && v.includes("HttpOnly") && v.includes("SameSite=Strict")));
  const header = setCookies.map(v=>v.split(";",1)[0]).join("; "); const agents = await fetch(`${x.base}/api/v1/agents`, { headers: { cookie: header } }); assert.equal(agents.status, 200);
  const mutation = await fetch(`${x.base}/api/v1/sessions/x/messages`, { method:"POST", headers:{ cookie:header, origin:x.base, "x-csrf-token":value.data.csrfToken, "content-type":"application/json" }, body:"{}" }); assert.equal(mutation.status,501);
});
test("generation endpoint returns one runId across the SSE lifecycle", async t => {
  const x = await fixture({ async generate(recordId, message, _signal, runId) { assert.equal(recordId, "record-1"); assert.equal(message, "虚构消息"); return { runId, entries: [{ type: "message" }] }; } }); t.after(()=>x.server.close());
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});
  const loginBody=await login.json() as {data:{csrfToken:string}}; const cookies=login.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
  const response=await fetch(`${x.base}/api/v1/sessions/record-1/messages`,{method:"POST",headers:{cookie:cookies,origin:x.base,"x-csrf-token":loginBody.data.csrfToken,"content-type":"application/json"},body:JSON.stringify({message:"虚构消息"})});
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8"); const events=await response.text(); assert.match(events,/event: run.started/); assert.match(events,/event: run.completed/); const ids=[...events.matchAll(/"runId":"([^"]+)"/g)].map(value=>value[1]); assert.equal(ids.length,2); assert.equal(ids[0],ids[1]);
});

test("结构化命令接口受登录和 CSRF 保护并委托命令派发器", async t => {
  const calls: unknown[] = []; const x = await fixture(undefined, undefined, { async dispatch(recordId, request) { calls.push([recordId, request]); return { effect: "read" }; } }); t.after(() => x.server.close());
  const unauthenticated = await fetch(`${x.base}/api/v1/sessions/record/command`, { method: "POST", headers: { origin: x.base, "content-type": "application/json" }, body: JSON.stringify({ command: "status", args: [] }) }); assert.equal(unauthenticated.status, 401);
  const login = await fetch(`${x.base}/api/v1/auth/login`, { method: "POST", headers: { origin: x.base, "content-type": "application/json" }, body: JSON.stringify({ username: "owl", password: "correct" }) });
  const loginBody = await login.json() as { data: { csrfToken: string } }; const cookies = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const response = await fetch(`${x.base}/api/v1/sessions/record/command`, { method: "POST", headers: { cookie: cookies, origin: x.base, "x-csrf-token": loginBody.data.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ command: "status", args: [] }) });
  assert.equal(response.status, 200); assert.deepEqual(calls, [["record", { command: "status", args: [] }]]);
});

test("fixed Host policy, logout, request limit, and static symlink boundary", async t => {
  const publicDir=await mkdtemp(join(tmpdir(),"panel-web-secure-")), outside=join(await mkdtemp(join(tmpdir(),"panel-outside-")),"secret.txt"); await writeFile(join(publicDir,"index.html"),"ok"); await writeFile(outside,"secret"); await symlink(outside,join(publicDir,"escape.txt"));
  const auth={username:"owl",passwordHash:passwordHash("correct","0011223344556677"),sessionSecret:"test-secret-long-enough"};
  const allowedHosts:string[]=[],publicOrigins:string[]=[]; const server=createPanelServer({auth,publicDir,allowedHosts,publicOrigins,generation:{async generate(_recordId,_message,_signal,runId){return {runId,entries:[]}}}}); server.listen(0,"127.0.0.1"); await once(server,"listening"); t.after(()=>server.close()); const address=server.address(); if(!address||typeof address==="string")throw new Error("no address"); const base=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/`)).status,421); allowedHosts.push(`127.0.0.1:${address.port}`,"panel.test"); publicOrigins.push(base,"http://panel.test");
  assert.equal((await fetch(`${base}/escape.txt`,{headers:{host:"panel.test"}})).status,404);
  const login=await fetch(`${base}/api/v1/auth/login`,{method:"POST",headers:{host:"panel.test",origin:"http://panel.test","content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})}); const value=await login.json() as {data:{csrfToken:string}}; const cookieHeader=login.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
  const huge=await fetch(`${base}/api/v1/sessions/x/messages`,{method:"POST",headers:{host:"panel.test",origin:"http://panel.test",cookie:cookieHeader,"x-csrf-token":value.data.csrfToken,"content-type":"application/json"},body:JSON.stringify({message:"x".repeat(17000)})}); assert.equal(huge.status,413);
  const logout=await fetch(`${base}/api/v1/auth/logout`,{method:"POST",headers:{host:"panel.test",origin:"http://panel.test",cookie:cookieHeader,"x-csrf-token":value.data.csrfToken}}); assert.equal(logout.status,200); assert.ok(logout.headers.getSetCookie().every(item=>item.includes("Max-Age=0")));
});
test("mutation requires matching CSRF token and login is origin checked", async t => {
  const x=await fixture(); t.after(()=>x.server.close());
  const rejected=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:"https://evil.example","content-type":"application/json"},body:'{}'}); assert.equal(rejected.status,403);
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})}); const cookies=login.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
  const mutation=await fetch(`${x.base}/api/v1/sessions/x/messages`,{method:"POST",headers:{cookie:cookies,origin:x.base,"content-type":"application/json"},body:'{}'}); assert.equal(mutation.status,403);
});

test("search、fork 和编辑重发 HTTP 接口委托给受限数据层", async t => {
  const calls: string[] = [];
  const reads: ReadApi = {
    async agents(){return []}, async sessions(){return []}, async conversation(){return null},
    async search(query, agentId){calls.push(`search:${query}:${agentId}`);return [{safe:true}]},
    async createPanel(agentId,title){calls.push(`create:${agentId}:${title}`);return {recordId:"panel-new"}},
    async updateSession(recordId,patch){calls.push(`update:${recordId}:${patch.title}:${patch.archived}`);return {recordId,...patch}},
    async deleteSession(recordId,confirmed){calls.push(`delete:${recordId}:${confirmed}`);return {action:"deleted"}},
    async fork(recordId,messageId){if(recordId==="missing")throw new Error("SESSION_NOT_FOUND");if(messageId==="bad")throw new ForkError("FORK_BOUNDARY_INVALID","该 entry 不是合法 fork 边界");calls.push(`fork:${recordId}:${messageId}`);return {recordId:"panel-fork"}},
    async editAndFork(recordId,messageId,replacement){if(messageId==="assistant")throw new Error("EDIT_TARGET_NOT_USER");calls.push(`edit:${recordId}:${messageId}:${replacement}`);return {recordId:"panel-edit"}}
  };
  const x=await fixture(undefined,reads);t.after(()=>x.server.close());
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});
  const loginBody=await login.json() as {data:{csrfToken:string}}; const cookieHeader=login.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
  const auth={cookie:cookieHeader,origin:x.base,"x-csrf-token":loginBody.data.csrfToken,"content-type":"application/json"};
  assert.equal((await fetch(`${x.base}/api/v1/search?q=needle&agentId=safe`,{headers:{cookie:cookieHeader}})).status,200);
  assert.equal((await fetch(`${x.base}/api/v1/sessions`,{method:"POST",headers:auth,body:JSON.stringify({agentId:"safe",title:"New"})})).status,201);
  assert.equal((await fetch(`${x.base}/api/v1/sessions/source`,{method:"PATCH",headers:auth,body:JSON.stringify({title:"Renamed",archived:true})})).status,200);
  assert.equal((await fetch(`${x.base}/api/v1/sessions/source`,{method:"DELETE",headers:auth,body:JSON.stringify({confirm:true})})).status,200);
  const unconfirmed=await fetch(`${x.base}/api/v1/sessions/source`,{method:"DELETE",headers:auth,body:JSON.stringify({})});assert.equal(unconfirmed.status,400);assert.equal((await unconfirmed.json()).error.code,"SESSION_DELETE_CONFIRMATION_REQUIRED");
  assert.equal((await fetch(`${x.base}/api/v1/sessions/source/fork`,{method:"POST",headers:auth,body:JSON.stringify({messageId:"a1"})})).status,201);
  assert.equal((await fetch(`${x.base}/api/v1/sessions/source/messages/u1/resend`,{method:"POST",headers:auth,body:JSON.stringify({message:"replacement"})})).status,201);
  const missing=await fetch(`${x.base}/api/v1/sessions/missing/fork`,{method:"POST",headers:auth,body:JSON.stringify({messageId:"a1"})});assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,"SESSION_NOT_FOUND");
  const boundary=await fetch(`${x.base}/api/v1/sessions/source/fork`,{method:"POST",headers:auth,body:JSON.stringify({messageId:"bad"})});assert.equal(boundary.status,409);assert.equal((await boundary.json()).error.code,"FORK_BOUNDARY_INVALID");
  const edit=await fetch(`${x.base}/api/v1/sessions/source/messages/assistant/resend`,{method:"POST",headers:auth,body:JSON.stringify({message:"replacement"})});assert.equal(edit.status,409);assert.equal((await edit.json()).error.code,"EDIT_TARGET_NOT_USER");
  assert.deepEqual(calls,["search:needle:safe","create:safe:New","update:source:Renamed:true","delete:source:true","fork:source:a1","edit:source:u1:replacement"]);
});

test("上下文超预算通过 SSE 返回稳定错误码和中文说明", async t => {
  const x=await fixture({async generate(){throw new ContextBudgetExceededError({estimatedTokens:120,budgetTokens:100,remainingTokens:0,method:"utf8-bytes-upper-bound-v2"})}});t.after(()=>x.server.close());
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});const loginBody=await login.json() as {data:{csrfToken:string}};const cookies=login.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
  const response=await fetch(`${x.base}/api/v1/sessions/record/messages`,{method:"POST",headers:{cookie:cookies,origin:x.base,"x-csrf-token":loginBody.data.csrfToken,"content-type":"application/json"},body:JSON.stringify({message:"fixture"})});const events=await response.text();
  assert.match(events,/"code":"CONTEXT_BUDGET_EXCEEDED"/);assert.match(events,/第一版不会自动删减/);assert.match(events,/"estimatedTokens":120/);
});

test("SSE 客户端断线会触发 AbortSignal 且不会伪报完成", async t => {
  let observed!:()=>void;const seen=new Promise<void>(resolve=>{observed=resolve});let aborted=false;
  const x=await fixture({async generate(_recordId,_message,signal,runId){observed();await new Promise<void>((_resolve,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(new Error("BRIDGE_ABORTED"))},{once:true}));return{runId,entries:[]}}});t.after(()=>x.server.close());
  const login=await fetch(`${x.base}/api/v1/auth/login`,{method:"POST",headers:{origin:x.base,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});const body=await login.json() as{data:{csrfToken:string}};const cookies=login.headers.getSetCookie().map(v=>v.split(";",1)[0]).join("; ");
  const controller=new AbortController();const response=await fetch(`${x.base}/api/v1/sessions/record/messages`,{method:"POST",signal:controller.signal,headers:{cookie:cookies,origin:x.base,"x-csrf-token":body.data.csrfToken,"content-type":"application/json"},body:JSON.stringify({message:"disconnect fixture"})});
  await seen;controller.abort();await assert.rejects(response.text(),/abort/i);for(let i=0;i<20&&!aborted;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(aborted,true);
});
