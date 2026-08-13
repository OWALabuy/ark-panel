import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Run = Record<string, unknown>;
type Registry = {
  readStoredEntries(): Array<{key:string;raw:string|null}>;
  key(recordId:string): string;
  get(recordId:string): Run|undefined;
};
type Options = {
  registry: Registry;
  removeStoredKey(key:string): void;
  rememberLocal(value:Run): Run;
  reconcileCreation(run:Run): unknown;
  getActive(recordId:string): Promise<unknown>;
  rememberAccepted(snapshot:unknown,local:undefined): Run;
  settle(run:Run): Promise<boolean>;
  watch(run:Run): unknown;
};

async function bootstrap(){
  return await import(pathToFileURL(join(process.cwd(),"src/frontend/run-bootstrap.js")).href) as {
    createRunBootstrap(options:Options):{recoverStored():void;reconcileSession(recordId:string):Promise<void>};
  };
}

const runId="11111111-1111-4111-8111-111111111111";
const otherRunId="22222222-2222-4222-8222-222222222222";
const key=(recordId:string)=>`ark-panel:run:v1:${encodeURIComponent(recordId)}`;
const stored=(recordId:string,id=runId)=>({runId:id,recordId,status:"accepted",submittedDraft:"fixture",submittedAttachmentIds:[],submittedRequestOutputs:false});

function setup(overrides:Partial<Options>={}){
  const calls:string[]=[];
  const options:Options={
    registry:{readStoredEntries:()=>[],key,get:()=>undefined},
    removeStoredKey:value=>{calls.push(`remove:${value}`)},
    rememberLocal:value=>{calls.push(`remember:${value.recordId}`);return value},
    reconcileCreation:value=>{calls.push(`reconcile:${value.recordId}`)},
    getActive:async recordId=>{calls.push(`get:${recordId}`);return null},
    rememberAccepted:snapshot=>{calls.push("accepted");return snapshot as Run},
    settle:async run=>{calls.push(`settle:${run.recordId}`);return false},
    watch:run=>{calls.push(`watch:${run.recordId}`)},
    ...overrides
  };
  return{calls,options};
}

test("stored inspection removes every invalid or colliding key before reconciling valid runs",async()=>{
  const entries=[
    {key:key("invalid"),raw:"{"},
    {key:key("collision-a"),raw:JSON.stringify(stored("collision-a",otherRunId))},
    {key:key("collision-b"),raw:JSON.stringify(stored("collision-b",otherRunId))},
    {key:key("valid"),raw:JSON.stringify(stored("valid"))}
  ];
  const {createRunBootstrap}=await bootstrap(),{calls,options}=setup({registry:{readStoredEntries:()=>entries,key,get:()=>undefined}});
  createRunBootstrap(options).recoverStored();
  assert.deepEqual(calls,[`remove:${key("invalid")}`,`remove:${key("collision-a")}`,`remove:${key("collision-b")}`,"remember:valid","reconcile:valid"]);
});

test("stored inspection preserves the registry key receiver",async()=>{
  const entry={key:key("receiver"),raw:JSON.stringify(stored("receiver"))};
  const registry={
    prefix:"ark-panel:run:v1:",
    readStoredEntries:()=>[entry],
    key(recordId:string){return `${this.prefix}${encodeURIComponent(recordId)}`},
    get:()=>undefined
  };
  const {createRunBootstrap}=await bootstrap(),{calls,options}=setup({registry});
  createRunBootstrap(options).recoverStored();
  assert.deepEqual(calls,["remember:receiver","reconcile:receiver"]);
});

test("stored recovery stops and swallows a synchronous failure at each step",async()=>{
  const entry={key:key("valid"),raw:JSON.stringify(stored("valid"))};
  const {createRunBootstrap}=await bootstrap();
  for(const stage of ["read","remove","remember","reconcile"]){
    const entries=stage==="remove"?[{key:key("bad"),raw:"{"},entry]:[entry];
    const {calls,options}=setup({
      registry:{readStoredEntries:()=>{calls.push("read");if(stage==="read")throw new Error(stage);return entries},key,get:()=>undefined},
      removeStoredKey:value=>{calls.push(`remove:${value}`);if(stage==="remove")throw new Error(stage)},
      rememberLocal:value=>{calls.push("remember");if(stage==="remember")throw new Error(stage);return value},
      reconcileCreation:()=>{calls.push("reconcile");if(stage==="reconcile")throw new Error(stage)}
    });
    assert.doesNotThrow(()=>createRunBootstrap(options).recoverStored());
    assert.equal(calls.at(-1),stage==="read"?"read":stage==="remove"?`remove:${key("bad")}`:stage);
  }
});

test("session bootstrap uses local runs without GET and treats null as a no-op",async()=>{
  const {createRunBootstrap}=await bootstrap(),local=stored("local");
  const first=setup({registry:{readStoredEntries:()=>[],key,get:()=>local}});
  await createRunBootstrap(first.options).reconcileSession("local");
  assert.deepEqual(first.calls,["reconcile:local"]);
  const second=setup();
  await createRunBootstrap(second.options).reconcileSession("empty");
  assert.deepEqual(second.calls,["get:empty"]);
});

test("active terminal runs settle without watching while running runs are watched",async()=>{
  const {createRunBootstrap}=await bootstrap();
  for(const terminal of [true,false]){
    const snapshot={...stored(terminal?"terminal":"running"),status:terminal?"completed":"running"};
    const {calls,options}=setup({getActive:async()=>snapshot,settle:async run=>{calls.push(`settle:${run.recordId}`);return terminal}});
    await createRunBootstrap(options).reconcileSession(String(snapshot.recordId));
    assert.deepEqual(calls,terminal?["accepted","settle:terminal"]:["accepted","settle:running","watch:running"]);
  }
});

test("active lookup, acceptance, and settling failures are swallowed",async()=>{
  const {createRunBootstrap}=await bootstrap();
  for(const stage of ["get","remember","settle"]){
    const snapshot=stored("failure");
    const {options}=setup({
      getActive:async()=>{if(stage==="get")throw new Error(stage);return snapshot},
      rememberAccepted:value=>{if(stage==="remember")throw new Error(stage);return value as Run},
      settle:async()=>{if(stage==="settle")throw new Error(stage);return true}
    });
    await assert.doesNotReject(createRunBootstrap(options).reconcileSession("failure"));
  }
});
