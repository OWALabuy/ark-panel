import assert from "node:assert/strict";
import test from "node:test";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

type Run=Record<string,unknown>&{runId:string,recordId:string,status:string};
type Reconciler={reconcile(value:Run):Promise<void>};
type Actions={
  current:(recordId:string)=>Run|undefined;
  merge:(current:Run,run:Run)=>Run;
  getRun:(runId:string)=>Promise<unknown>;
  getActive:(recordId:string)=>Promise<unknown>;
  create:(run:Run)=>Promise<unknown>;
  rememberAccepted:(snapshot:unknown,run:Run)=>Run;
  consumeAccepted:(run:Run)=>void;
  settle:(run:Run)=>Promise<boolean>;
  watch:(run:Run)=>unknown;
  discard:(run:Run)=>void;
  onMissing:(run:Run)=>void;
  onFailed:(run:Run,error:unknown,retry:()=>Promise<void>)=>void;
  onRetrying:(stage:"observe"|"create",run:Run,error:unknown)=>void;
  delay:(milliseconds:number)=>Promise<void>;
};

const initial:Run={
  runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",status:"accepted",
  createPhase:"provisional",storageAvailable:true,submittedDraft:"fixture message",
  submittedAttachmentIds:[],submittedRequestOutputs:false
};
const snapshot=(status="running"):Run=>({runId:initial.runId,recordId:initial.recordId,status,sequence:1});
const missing=()=>Object.assign(new Error("missing"),{status:404,code:"RUN_NOT_FOUND"});

async function factory(actions:Actions):Promise<Reconciler>{
  const url=pathToFileURL(join(process.cwd(),"src/frontend/run-creation-reconciler.js")).href;
  const module=await import(`${url}?creation-reconciler`) as {createRunCreationReconciler(actions:Actions):Reconciler};
  return module.createRunCreationReconciler(actions);
}

function harness(overrides:Partial<Actions>={}){
  const calls:string[]=[];
  const actions:Actions={
    current(recordId){calls.push(`current:${recordId}`);return undefined},
    merge(current,run){calls.push("merge");return{...run,...current}},
    async getRun(runId){calls.push(`getRun:${runId}`);return snapshot()},
    async getActive(recordId){calls.push(`getActive:${recordId}`);return null},
    async create(run){calls.push(`create:${String(run.submittedDraft)}`);return snapshot()},
    rememberAccepted(value,run){calls.push(`remember:${String((value as Run).status)}:${String(run.submittedDraft)}`);return{...run,...value as Run}},
    consumeAccepted(run){calls.push(`consume:${run.status}`)},
    async settle(run){calls.push(`settle:${run.status}`);return run.status==="completed"},
    watch(run){calls.push(`watch:${run.status}`)},
    discard(run){calls.push(`discard:${String(run.submittedDraft)}`)},
    onMissing(){calls.push("missing")},
    onFailed(_run,error){calls.push(`failed:${error instanceof Error?error.message:"error"}`)},
    onRetrying(stage){calls.push(`retrying:${stage}`)},
    async delay(milliseconds){calls.push(`delay:${milliseconds}`)},
    ...overrides
  };
  return{actions,calls};
}

test("a found run is remembered, consumed, settled, and watched in exact order",async()=>{
  const {actions,calls}=harness();
  await (await factory(actions)).reconcile(initial);
  assert.deepEqual(calls,[
    "current:fixture-session","getRun:11111111-1111-4111-8111-111111111111",
    "remember:running:fixture message","consume:running","settle:running","watch:running"
  ]);
});

test("a terminal accepted snapshot settles without starting a watcher",async()=>{
  const {actions,calls}=harness({
    async getRun(){calls.push("getRun");return snapshot("completed")},
    async settle(run){calls.push(`settle:${run.status}`);return true}
  });
  await (await factory(actions)).reconcile(initial);
  assert.deepEqual(calls,["current:fixture-session","getRun","remember:completed:fixture message","consume:completed","settle:completed"]);
});

test("404 run lookup checks active then creates and hands off the created run",async()=>{
  const {actions,calls}=harness({async getRun(){calls.push("getRun");throw missing()}});
  await (await factory(actions)).reconcile(initial);
  assert.deepEqual(calls,[
    "current:fixture-session","getRun","getActive:fixture-session","create:fixture message",
    "remember:running:fixture message","consume:running","settle:running","watch:running"
  ]);
});

test("each retry refreshes matching registry state before policy operations",async()=>{
  let reads=0;
  const {actions,calls}=harness({
    current(){calls.push("current");reads++;return reads===2?{...initial,submittedDraft:"refreshed"}:initial},
    async getRun(){calls.push("getRun");if(reads===1)throw new TypeError("offline");throw missing()},
    async create(run){calls.push(`create:${String(run.submittedDraft)}`);return snapshot("completed")},
    async settle(run){calls.push(`settle:${String(run.submittedDraft)}`);return true}
  });
  await (await factory(actions)).reconcile({...initial,submittedDraft:"stale"});
  assert.deepEqual(calls,[
    "current","merge","getRun","retrying:observe","delay:1500",
    "current","merge","getRun","getActive:fixture-session","create:refreshed",
    "remember:completed:refreshed","consume:completed","settle:refreshed"
  ]);
});

test("mismatched current run is ignored",async()=>{
  const {actions,calls}=harness({current(){calls.push("current");return{...initial,runId:"22222222-2222-4222-8222-222222222222",submittedDraft:"other"}}});
  await (await factory(actions)).reconcile(initial);
  assert.equal(calls.includes("merge"),false);
  assert.equal(calls.includes("remember:running:fixture message"),true);
});

test("discard reports missing after discarding unrecoverable local state",async()=>{
  const unrecoverable={...initial,submittedDraft:undefined};
  const {actions,calls}=harness({async getRun(){calls.push("getRun");throw missing()}});
  await (await factory(actions)).reconcile(unrecoverable);
  assert.deepEqual(calls,["current:fixture-session","getRun","getActive:fixture-session","discard:undefined","missing"]);
});

test("deterministic create failure discards then exposes a restart callback",async()=>{
  let retry:(()=>Promise<void>)|undefined,lookups=0;
  const rejected=Object.assign(new Error("invalid"),{status:400});
  const {actions,calls}=harness({
    async getRun(){calls.push("getRun");if(lookups++===0)throw missing();return snapshot("completed")},
    async create(){calls.push("create");throw rejected},
    onFailed(_run,error,next){calls.push(`failed:${(error as Error).message}`);retry=next}
  });
  const reconciler=await factory(actions);
  await reconciler.reconcile(initial);
  assert.deepEqual(calls,["current:fixture-session","getRun","getActive:fixture-session","create","discard:fixture message","failed:invalid"]);
  assert.equal(typeof retry,"function");
  await retry?.();
  assert.equal(lookups,2);
});

test("a synchronous failed callback starts a new task that the old finally cannot release",async()=>{
  let lookups=0,release:((value:unknown)=>void)|undefined,restarted:Promise<void>|undefined;
  const pending=new Promise(resolve=>{release=resolve});
  const invalid=Object.assign(new Error("invalid"),{status:400});
  const {actions}=harness({
    async getRun(){lookups++;if(lookups===1)throw missing();return pending},
    async create(){throw invalid},
    onFailed(_run,_error,retry){restarted=retry()},
    async settle(){return true}
  });
  const reconciler=await factory(actions),first=reconciler.reconcile(initial);
  await first;
  assert.equal(lookups,2);
  assert.equal(reconciler.reconcile(initial),restarted);
  release?.(snapshot("completed"));await restarted;
  const third=reconciler.reconcile(initial);assert.notEqual(third,restarted);await third;assert.equal(lookups,3);
});

test("observe and create uncertainty report their distinct retry stages with 1500ms delay",async()=>{
  let attempt=0;
  const {actions,calls}=harness({
    async getRun(){calls.push("getRun");if(attempt++===0)throw new TypeError("offline");throw missing()},
    async create(){calls.push("create");if(attempt===2)return {};return snapshot("completed")},
    async settle(){calls.push("settle");return true}
  });
  await (await factory(actions)).reconcile(initial);
  assert.deepEqual(calls.filter(call=>call.startsWith("retrying:")||call.startsWith("delay:")),[
    "retrying:observe","delay:1500","retrying:create","delay:1500"
  ]);
});

test("the same run id shares one promise and finally permits restart",async()=>{
  let release:((value:unknown)=>void)|undefined,queries=0;
  const pending=new Promise(resolve=>{release=resolve});
  const {actions}=harness({async getRun(){queries++;return pending}});
  const reconciler=await factory(actions),first=reconciler.reconcile(initial),second=reconciler.reconcile({...initial,recordId:"ignored"});
  assert.equal(first,second);assert.equal(queries,1);
  release?.(snapshot("completed"));await first;
  const third=reconciler.reconcile(initial);assert.notEqual(first,third);await third;assert.equal(queries,2);
});

test("a throwing callback rejects but finally still releases the run id",async()=>{
  let queries=0;
  const invalid=Object.assign(new Error("invalid"),{status:400});
  const {actions}=harness({
    async getRun(){queries++;if(queries===1)throw missing();return snapshot("completed")},
    async create(){throw invalid},
    onFailed(){throw new Error("callback failed")},
    async settle(){return true}
  });
  const reconciler=await factory(actions),first=reconciler.reconcile(initial);
  await assert.rejects(first,/callback failed/);
  const second=reconciler.reconcile(initial);assert.notEqual(first,second);await second;assert.equal(queries,2);
});
