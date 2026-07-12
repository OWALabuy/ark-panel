import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function freePort(): Promise<number> { const server=createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw new Error("port");const port=address.port;server.close();await once(server,"close");return port; }

test("main 从不同 cwd 启动时仍能提供静态资源和健康检查", async t => {
  const cwd=await mkdtemp(join(tmpdir(),"panel-cwd-")),port=await freePort();
  const child=spawn(process.execPath,[join(process.cwd(),"dist/src/server/main.js")],{cwd,env:{...process.env,PANEL_USERNAME:"owl",PANEL_PASSWORD_HASH:"scrypt:x:y",PANEL_SESSION_SECRET:"01234567890123456789012345678901",PANEL_PORT:String(port),PANEL_MOCK_DATA:"1"},stdio:["ignore","pipe","pipe"]});
  t.after(()=>{if(child.exitCode===null)child.kill("SIGTERM")});
  await Promise.race([once(child.stdout,"data"),once(child,"exit").then(()=>{throw new Error("服务提前退出")})]);
  const health=await fetch(`http://127.0.0.1:${port}/api/v1/health`);assert.equal(health.status,200);
  const page=await fetch(`http://127.0.0.1:${port}/`);assert.equal(page.status,200);assert.match(await page.text(),/ark-panel/);
  child.kill("SIGTERM");await once(child,"exit");
});
