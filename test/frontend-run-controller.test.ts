import assert from "node:assert/strict";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import test from "node:test";

const moduleUrl=pathToFileURL(join(process.cwd(),"src/frontend/run-controller.js")).href;
const {createRunController}=await import(`${moduleUrl}?run-controller`) as {createRunController(options:any):any};

const base={runId:"11111111-1111-4111-8111-111111111111",recordId:"session-1",status:"accepted"};

function harness(overrides:any={}){
  const calls:string[]=[],runs=new Map<string,any>(),forgotten:string[]=[],deleted:string[]=[];
  const clone=(value:any)=>structuredClone(value);
  const registry={
    normalize(value:any,fallback:any={}){const raw=value?.data&&typeof value.data==="object"?value.data:value||{};return clone({...fallback,...raw,runId:raw.runId||raw.id||fallback.runId||"",recordId:raw.recordId||raw.sessionId||fallback.recordId||"",status:raw.status||raw.state||fallback.status||"accepted"})},
    get(recordId:string){const value=runs.get(recordId);return value&&clone(value)},
    remember(value:any){const run=clone({...value,storageAvailable:value.storageAvailable!==false});runs.set(run.recordId,run);calls.push(`registry:local:${run.status}`);return clone(run)},
    rememberServer(value:any,local:any){const run=clone({...local,...value,createPhase:"acknowledged",storageAvailable:value.storageAvailable!==false});runs.set(run.recordId,run);calls.push(`registry:server:${run.runId}`);return clone(run)},
    forget(recordId:string){forgotten.push(recordId);calls.push(`forget:${recordId}`)},
    delete(recordId:string){runs.delete(recordId);deleted.push(recordId);calls.push(`delete:${recordId}`)}
  };
  const context={agentId:"agent-1",recordId:"session-1"};
  const events={
    remembered(run:any){calls.push(`remembered:${run.status}`)},discarded(run:any){calls.push(`discarded:${run.runId}`)},terminal(run:any){calls.push(`terminal:${run.status}`)},terminalActive(run:any){calls.push(`active:${run.status}`)},failedActive(){calls.push("failed-active")},async completedActive(){calls.push("reload:start");await overrides.reloadGate?.promise;calls.push("reload:end")},settled(){calls.push("settled")},abortUnknown(_run:any,error:any){calls.push(`abort-unknown:${error.message}`)}
  };
  const composer={discardCompletionOwnership(runId:any){calls.push(`ownership:discard:${runId}`)},complete(scope:any,run:any,draft:any){calls.push(`complete:${scope.agentId}:${scope.sessionId}:${run.runId}:${draft}`)}};
  const controller=createRunController({registry,composer,activeContext:()=>({...context}),currentDraft:()=>overrides.draft??"draft",invalidRunError:()=>new Error("localized invalid"),requestAbort:overrides.requestAbort||(async()=>({...base,status:"aborted"})),watch:(run:any)=>calls.push(`watch:${run.status}`),events});
  return{controller,calls,runs,forgotten,deleted,context,registry};
}

test("remembers local and server runs with validation, fallback agent, and storage fail-close",()=>{
  const h=harness();
  assert.throws(()=>h.controller.rememberLocal({status:"accepted"}),/localized invalid/);
  assert.equal(h.controller.rememberLocal({...base}).agentId,"agent-1");
  const accepted=h.controller.rememberServer({...base,storageAvailable:false},{...base,submittedDraft:"hello"});
  assert.equal(accepted.submittedDraft,"hello");
  assert.deepEqual(h.forgotten,["session-1"]);
  assert.equal(h.controller.current("session-1")?.runId,base.runId);
});

test("discards a matching run from registry or only stale storage before replacement",()=>{
  const h=harness();h.controller.rememberLocal({...base});h.calls.length=0;
  h.controller.discard({...base});
  assert.deepEqual(h.calls,["delete:session-1",`ownership:discard:${base.runId}`,`discarded:${base.runId}`]);
  const stale={...base,runId:"22222222-2222-4222-8222-222222222222"};h.controller.rememberLocal({...base});h.calls.length=0;
  h.controller.rememberServer({...base,runId:"33333333-3333-4333-8333-333333333333"},stale);
  assert.deepEqual(h.calls.slice(0,3),["forget:session-1",`ownership:discard:${stale.runId}`,`discarded:${stale.runId}`]);
});

test("ignores nonterminal settlement",async()=>{
  const h=harness();assert.equal(await h.controller.settle({...base,status:"running"}),false);assert.deepEqual(h.calls,[]);
});

test("completed active settlement clears owned state and waits for reload before final effects",async()=>{
  let release!:()=>void;const reloadGate={promise:new Promise<void>(resolve=>{release=resolve})},h=harness({reloadGate,draft:"new draft"});
  const task=h.controller.settle({...base,status:"completed",agentId:"agent-2"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls,["delete:session-1","terminal:completed",`complete:agent-2:session-1:${base.runId}:new draft`,"reload:start"]);
  release();assert.equal(await task,true);assert.deepEqual(h.calls.slice(-2),["reload:end","settled"]);
});

test("completed background settlement cleans its own scope without reloading",async()=>{
  const h=harness();h.context.recordId="other";
  assert.equal(await h.controller.settle({...base,status:"completed"}),true);
  assert.equal(h.calls.includes("reload:start"),false);assert.equal(h.calls.at(-1),"settled");
});

test("failed and aborted settlements retain composer state and only surface active failures",async()=>{
  const failed=harness();await failed.controller.settle({...base,status:"failed"});
  assert.deepEqual(failed.calls,["delete:session-1","terminal:failed",`ownership:discard:${base.runId}`,"active:failed","failed-active","settled"]);
  const aborted=harness();await aborted.controller.settle({...base,status:"aborted"});
  assert.deepEqual(aborted.calls,["delete:session-1","terminal:aborted",`ownership:discard:${base.runId}`,"active:aborted","settled"]);
  const background=harness();background.context.recordId="other";await background.controller.settle({...base,status:"failed"});
  assert.equal(background.calls.includes("failed-active"),false);
});

test("abort remembers aborting and terminal snapshots in order",async()=>{
  const h=harness();const result=await h.controller.abort({...base});
  assert.equal(result.kind,"terminal");
  assert.deepEqual(h.calls,["registry:local:aborting","remembered:aborting","registry:local:aborted","remembered:aborted","delete:session-1","terminal:aborted",`ownership:discard:${base.runId}`,"active:aborted","settled"]);
});

test("abort watches nonterminal snapshots and preserves the original run on unknown outcome",async()=>{
  const watching=harness({requestAbort:async()=>({...base,status:"aborting"})});
  assert.equal((await watching.controller.abort({...base})).kind,"watching");assert.equal(watching.calls.at(-1),"watch:aborting");
  const unknown=harness({requestAbort:async()=>{throw new Error("network")}});
  assert.equal((await unknown.controller.abort({...base})).kind,"unknown");
  assert.deepEqual(unknown.calls.slice(-2),["abort-unknown:network","watch:accepted"]);
});
