import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Stored = { key(index: number): string | null; readonly length: number; getItem(key: string): string | null; setItem(key: string,value: string): void; removeItem(key: string): void };
type Registry = { key(recordId: string): string; normalize(value: Record<string,unknown>,fallback?: Record<string,unknown>): Record<string,unknown>; get(recordId: string): Record<string,unknown>|undefined; has(recordId: string): boolean; remember(value: Record<string,unknown>): Record<string,unknown>; rememberServer(value: Record<string,unknown>,local?: Record<string,unknown>): Record<string,unknown>; forget(recordId: string): void; delete(recordId: string): void; readStoredEntries(): Array<{key:string,raw:string|null}> };

function memoryStorage(): Stored & {data: Map<string,string>} {
  const data=new Map<string,string>();
  return {data,get length(){return data.size},key(index){return [...data.keys()][index]??null},getItem(key){return data.get(key)??null},setItem(key,value){data.set(key,value)},removeItem(key){data.delete(key)}};
}

async function registry(storage: Stored): Promise<Registry> {
  const module=await import(pathToFileURL(join(process.cwd(),"src/frontend/run-registry.js")).href) as {createRunRegistry(options:{storage:Stored}):Registry};
  return module.createRunRegistry({storage});
}

test("run registry preserves the v1 storage bytes and protects its in-memory state",async()=>{
  const storage=memoryStorage(),runs=await registry(storage);
  const remembered=runs.remember({runId:"11111111-1111-4111-8111-111111111111",recordId:"session / one",agentId:"fixture-agent",status:"accepted",createPhase:"provisional",submittedDraft:"hello",submittedAttachmentIds:[],submittedRequestOutputs:false,stream:{state:"streaming",tools:[]}});
  const storageKey="ark-panel:run:v1:session%20%2F%20one";
  assert.equal(runs.key("session / one"),storageKey);
  assert.equal(storage.getItem(storageKey),'{"runId":"11111111-1111-4111-8111-111111111111","recordId":"session / one","agentId":"fixture-agent","status":"accepted","createPhase":"provisional","submittedDraft":"hello","submittedAttachmentIds":[],"submittedRequestOutputs":false}');
  (remembered.stream as {state:string}).state="mutated";
  const read=runs.get("session / one") as {status:string};read.status="failed";
  assert.equal((runs.get("session / one")?.stream as {state:string}).state,"streaming");
  assert.equal(runs.get("session / one")?.status,"accepted");
  assert.deepEqual(runs.readStoredEntries(),[{key:storageKey,raw:storage.getItem(storageKey)}]);
});

test("run registry preserves Error details but rejects unsupported or cyclic values",async()=>{
  const runs=await registry(memoryStorage()),failure=Object.assign(new Error("fictional failure"),{code:"UPSTREAM_FAILED",status:503,streamDropped:true});failure.name="FixtureError";
  const normalized=runs.normalize({runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",status:"failed",error:failure});
  const copied=normalized.error as Error & {code:string,status:number,streamDropped:boolean};
  assert.notEqual(copied,failure);
  assert.equal(copied.name,"FixtureError");
  assert.equal(copied.message,"fictional failure");
  assert.equal(copied.code,"UPSTREAM_FAILED");
  assert.equal(copied.status,503);
  assert.equal(copied.streamDropped,true);
  const remembered=runs.remember(normalized),rememberedError=remembered.error as Error & {code:string};rememberedError.code="MUTATED";
  assert.equal((runs.get("fixture-session")?.error as Error & {code:string}).code,"UPSTREAM_FAILED");
  for(const unsupported of [new Date("2026-01-01T00:00:00.000Z"),new Map([["status","failed"]])]){
    assert.throws(()=>runs.normalize({runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",unsupported}),/^Error: RUN_INVALID$/);
  }
  const cyclic: Record<string,unknown>={};cyclic.self=cyclic;
  assert.throws(()=>runs.remember({runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",cyclic}),/^Error: RUN_INVALID$/);
});

test("storage-only forget keeps the live run and server replacement does not discard another record",async()=>{
  const storage=memoryStorage(),runs=await registry(storage),local=runs.remember({runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",agentId:"fixture-agent",status:"accepted",createPhase:"provisional"});
  runs.forget("fixture-session");
  assert.equal(runs.has("fixture-session"),true);
  assert.equal(storage.length,0);
  runs.rememberServer({runId:"22222222-2222-4222-8222-222222222222",recordId:"other-session",status:"running"},local);
  assert.equal(runs.get("fixture-session")?.runId,"11111111-1111-4111-8111-111111111111");
  assert.equal(runs.get("other-session")?.runId,"22222222-2222-4222-8222-222222222222");
  runs.delete("fixture-session");
  assert.equal(runs.has("fixture-session"),false);
});

test("normalization preserves run phases and deliberately clears an absent stream snapshot",async()=>{
  const runs=await registry(memoryStorage()),fallback={runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",status:"running",createPhase:"provisional",storageAvailable:false,stream:{state:"streaming"}};
  const absent=runs.normalize({data:{status:"materializing"}},fallback);
  assert.equal(absent.status,"materializing");
  assert.equal(absent.createPhase,"provisional");
  assert.equal(absent.storageAvailable,false);
  assert.equal(Object.hasOwn(absent,"stream"),true);
  assert.equal(absent.stream,undefined);
  const explicit=runs.normalize({data:{stream:null}},fallback);
  assert.equal(explicit.stream,null);
});

test("a failed persistence attempt is reflected without exposing mutable registry state",async()=>{
  let attempts=0;
  const data=new Map<string,string>(),storage: Stored={get length(){return data.size},key(index){return [...data.keys()][index]??null},getItem(key){return data.get(key)??null},setItem(){attempts++;throw new Error("quota")},removeItem(key){data.delete(key)}};
  const runs=await registry(storage),failed=runs.remember({runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",status:"accepted",createPhase:"provisional"}),run=runs.remember({...failed,status:"running"});
  assert.equal(attempts,1,"known-unavailable storage is not retried by a later snapshot");
  assert.equal(run.storageAvailable,false);
  assert.equal(runs.get("fixture-session")?.storageAvailable,false);
});
