import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Run={runId:string,recordId:string,status:string,sequence?:number};
type Observer={watch(value:Run):Promise<void>};
type Options={
  query:(run:Run)=>Promise<unknown>;
  openEvents:(run:Run)=>Promise<unknown>;
  consumeEvents:(response:unknown,onEvent:(name:string,data:Run)=>void)=>Promise<Run>;
  remember:(value:unknown,local:Run)=>Run;
  settle:(run:Run)=>Promise<boolean>;
  discard:(run:Run)=>void;
  onMissing:(run:Run)=>void;
  onConnectionLost:(run:Run,error:unknown)=>void;
  delay:(milliseconds:number)=>Promise<void>;
};

const initial:Run={runId:"11111111-1111-4111-8111-111111111111",recordId:"fixture-session",status:"running"};

async function factory(options:Options):Promise<Observer>{
  const url=pathToFileURL(join(process.cwd(),"src/frontend/run-observer.js")).href;
  const module=await import(`${url}?run-observer`) as {createRunObserver(options:Options):Observer};
  return module.createRunObserver(options);
}

function harness(overrides:Partial<Options>={}){
  const calls:string[]=[];
  const options:Options={
    async query(){calls.push("query");return {...initial,status:"running",sequence:1}},
    async openEvents(){calls.push("open");return "events"},
    async consumeEvents(_response,onEvent){calls.push("consume");onEvent("run.running",{...initial,status:"running",sequence:2});onEvent("run.completed",{...initial,status:"running",sequence:3});return {...initial,status:"completed",sequence:3}},
    remember(value){const run=value as Run;calls.push(`remember:${run.status}:${run.sequence??"-"}`);return {...run}},
    async settle(run){calls.push(`settle:${run.status}:${run.sequence??"-"}`);return run.status==="completed"||run.status==="failed"||run.status==="aborted"},
    discard(){calls.push("discard")},
    onMissing(){calls.push("missing")},
    onConnectionLost(_run,error){calls.push(`lost:${error instanceof Error?error.name:"error"}`)},
    async delay(milliseconds){calls.push(`delay:${milliseconds}`)},
    ...overrides
  };
  return{calls,options};
}

test("terminal GET snapshots settle without opening SSE and preserve callback order",async()=>{
  const {calls,options}=harness({async query(){calls.push("query");return {...initial,status:"completed",sequence:4}}});
  await (await factory(options)).watch(initial);
  assert.deepEqual(calls,["query","remember:completed:4","settle:completed:4"]);
});

test("SSE events are remembered and the terminal snapshot is settled in order",async()=>{
  const {calls,options}=harness();
  await (await factory(options)).watch(initial);
  assert.deepEqual(calls,[
    "query","remember:running:1","settle:running:1","open","consume",
    "remember:running:2","remember:completed:3","remember:completed:3","settle:completed:3"
  ]);
});

test("404 discards the current run, reports missing, and stops",async()=>{
  const missing=Object.assign(new Error("missing"),{status:404});
  const {calls,options}=harness({async query(){calls.push("query");throw missing}});
  await (await factory(options)).watch(initial);
  assert.deepEqual(calls,["query","discard","missing"]);
});

test("a 404 while consuming SSE applies the same missing-run stop path",async()=>{
  const missing=Object.assign(new Error("missing"),{status:404});
  const {calls,options}=harness({async consumeEvents(){calls.push("consume");throw missing}});
  await (await factory(options)).watch(initial);
  assert.deepEqual(calls,["query","remember:running:1","settle:running:1","open","consume","discard","missing"]);
});

const retryCases:Array<[string,(calls:string[])=>Partial<Options>]>=[
  ["snapshot network error",calls=>{let count=0;return {query:async()=>{calls.push("query");if(count++===0)throw new TypeError("offline");return {...initial,status:"completed"}}}}],
  ["SSE read error",calls=>{let count=0;return {consumeEvents:async()=>{calls.push("consume");if(count++===0)throw new Error("read failed");return {...initial,status:"completed"}}}}],
  ["nonterminal EOF",calls=>{let count=0;return {consumeEvents:async()=>{calls.push("consume");if(count++===0)throw Object.assign(new Error("ended before terminal"),{streamDropped:true});return {...initial,status:"completed"}}}}]
];
for(const [name,fail] of retryCases){
  test(`${name} reports connection loss and retries after 1500ms`,async()=>{
    const base=harness(),override=fail(base.calls),options={...base.options,...override} as Options;
    await (await factory(options)).watch(initial);
    assert.equal(base.calls.filter(call=>call==="delay:1500").length,1);
    assert.equal(base.calls.filter(call=>call.startsWith("lost:")).length,1);
    assert.equal(base.calls.filter(call=>call==="query").length,2);
  });
}

test("AbortError follows the ordinary connection-loss retry path",async()=>{
  let count=0;const {calls,options}=harness({async query(){calls.push("query");if(count++===0)throw new DOMException("aborted","AbortError");return {...initial,status:"completed"}}});
  await (await factory(options)).watch(initial);
  assert.deepEqual(calls.slice(0,3),["query","lost:AbortError","delay:1500"]);
});

test("the same run id shares one watcher",async()=>{
  let release:((value:unknown)=>void)|undefined,queries=0;
  const pending=new Promise(resolve=>{release=resolve});
  const {options}=harness({async query(){queries++;return pending}}),observer=await factory(options);
  const first=observer.watch(initial),second=observer.watch({...initial,recordId:"ignored-duplicate"});
  assert.equal(first,second);assert.equal(queries,1);
  release?.({...initial,status:"completed"});await first;
});

test("a watcher can restart after finally releases its run id",async()=>{
  let queries=0;const {options}=harness({async query(){queries++;return {...initial,status:"completed"}}}),observer=await factory(options);
  const first=observer.watch(initial);await first;
  const second=observer.watch(initial);await second;
  assert.notEqual(first,second);assert.equal(queries,2);
});

test("a throwing injected retry callback rejects and still releases the watcher",async()=>{
  let queries=0;const {options}=harness({
    async query(){if(queries++===0)throw new TypeError("offline");return {...initial,status:"completed"}},
    async delay(){throw new Error("retry callback failed")}
  }),observer=await factory(options);
  const first=observer.watch(initial);
  await assert.rejects(first,/retry callback failed/);
  const second=observer.watch(initial);
  assert.notEqual(first,second);await second;assert.equal(queries,2);
});
