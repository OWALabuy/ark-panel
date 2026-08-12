import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { observeChildClose, stopChildProcess, tempFixture, withTimeout } from "./test-helpers.js";
import { passwordHash } from "../src/server/auth.js";

async function freePort(): Promise<number> { const server=createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("port");const port=address.port;server.close();await once(server,"close");return port; }

function childEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  const environment = { ...process.env }; delete environment.PANEL_PUBLIC_ORIGIN; delete environment.PANEL_TRUSTED_HOSTS; delete environment.PANEL_SECURE_COOKIE;
  return { ...environment, ...values };
}

async function localHttp(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return await new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; text: string }>((resolveResponse, rejectResponse) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolveResponse({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", rejectResponse); request.end(options.body);
  });
}

test("main 从不同 cwd 启动时仍能提供静态资源和健康检查", async t => {
  const cwd=await tempFixture(t,"panel-cwd-"),port=await freePort();
  const child=spawn(process.execPath,[join(process.cwd(),"dist/src/server/main.js")],{cwd,env:childEnvironment({PANEL_USERNAME:"owl",PANEL_PASSWORD_HASH:"scrypt:x:y",PANEL_SESSION_SECRET:"01234567890123456789012345678901",PANEL_PORT:String(port),PANEL_MOCK_DATA:"1"}),stdio:["ignore","pipe","pipe"]});
  const closed=observeChildClose(child);let output:ReturnType<typeof createInterface>|undefined;
  try {
    output=createInterface({input:child.stdout});
    const line=await withTimeout(Promise.race([
      once(output,"line").then(([value])=>String(value)),
      closed.then(({code,signal})=>{throw new Error(`服务提前退出: code=${String(code)} signal=${String(signal)}`)})
    ]),"panel listening event",5_000);
    assert.equal(line,`会话面板监听 http://127.0.0.1:${port}`);
    const health=await fetch(`http://127.0.0.1:${port}/api/v1/health`);assert.equal(health.status,200);
    const page=await fetch(`http://127.0.0.1:${port}/`);assert.equal(page.status,200);assert.match(await page.text(),/ark-panel/);
  } finally {
    output?.close();await stopChildProcess(child,closed,"panel fixture child");
  }
});

test("main 显式接入 HTTPS public origin 且不信任 forwarded headers", async t => {
  const cwd=await tempFixture(t,"panel-proxy-main-"),port=await freePort(),externalOrigin="https://panel.example.test";
  const child=spawn(process.execPath,[join(process.cwd(),"dist/src/server/main.js")],{cwd,env:childEnvironment({PANEL_USERNAME:"owl",PANEL_PASSWORD_HASH:passwordHash("correct","0011223344556677"),PANEL_SESSION_SECRET:"01234567890123456789012345678901",PANEL_PORT:String(port),PANEL_MOCK_DATA:"1",PANEL_PUBLIC_ORIGIN:externalOrigin,PANEL_TRUSTED_HOSTS:"[]",PANEL_SECURE_COOKIE:"1"}),stdio:["ignore","pipe","pipe"]});
  const closed=observeChildClose(child);let output:ReturnType<typeof createInterface>|undefined;
  try {
    output=createInterface({input:child.stdout});
    const line=await withTimeout(Promise.race([once(output,"line").then(([value])=>String(value)),closed.then(({code,signal})=>{throw new Error(`服务提前退出: code=${String(code)} signal=${String(signal)}`)})]),"panel listening event",5_000);
    assert.equal(line,`会话面板监听 http://127.0.0.1:${port}`);assert.doesNotMatch(line,/panel\.example\.test/);
    const page=await localHttp(port,"/",{headers:{host:"panel.example.test"}});assert.equal(page.status,200);
    const login=await localHttp(port,"/api/v1/auth/login",{method:"POST",headers:{host:"panel.example.test",origin:externalOrigin,"content-type":"application/json"},body:JSON.stringify({username:"owl",password:"correct"})});
    assert.equal(login.status,200);assert.ok((login.headers["set-cookie"]??[]).every(value=>value.includes("Secure")));
    const poisoned=await localHttp(port,"/",{headers:{host:"attacker.invalid","x-forwarded-host":"panel.example.test","x-forwarded-proto":"https"}});
    assert.equal(poisoned.status,421);assert.equal(JSON.parse(poisoned.text).error.code,"HOST_REJECTED");
  } finally {
    output?.close();await stopChildProcess(child,closed,"panel proxy fixture child");
  }
});

test("进程清理复用已经发生的 signal exit，不会等待错过的事件", async t => {
  const child=spawn(process.execPath,["-e","setInterval(()=>undefined,1000)"],{stdio:"ignore"}),closed=observeChildClose(child);
  try {
    child.kill("SIGTERM");
    const observed=await withTimeout(closed,"fixture child signal close");
    assert.deepEqual(observed,{code:null,signal:"SIGTERM"});assert.equal(child.exitCode,null);assert.equal(child.signalCode,"SIGTERM");
    assert.deepEqual(await stopChildProcess(child,closed,"already signal-exited fixture child"),observed);
  } finally {
    await stopChildProcess(child,closed,"signal-exited fixture child");
  }
});

test("systemd 沙箱保持真实 sessions 只读并放行记忆文件与派生索引", async () => {
  const unit = await readFile(join(process.cwd(), "deploy", "ark-panel.service"), "utf8");
  assert.match(unit, /ReadOnlyPaths=.*\/agents\/claude\/sessions .*\/agents\/main\/sessions/);
  assert.match(unit, /ReadWritePaths=.*\/claude\/memory .*\/clawd\/memory/);
  for (const agent of ["claude", "main", "panel-runtime-claude", "panel-runtime-main", "panel-memory-claude", "panel-memory-main"]) {
    assert.match(unit, new RegExp(`/agents/${agent}/agent(?: |\\n)`));
  }
  assert.doesNotMatch(unit, /ReadWritePaths=.*\/agents\/(?:claude|main)\/sessions/);
});
