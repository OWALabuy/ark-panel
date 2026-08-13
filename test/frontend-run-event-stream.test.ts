import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type StreamErrorInput = { kind: "requestFailed" | "streamExpected" | "streamEnded"; message?: string };
type StreamError = Error & { kind?: StreamErrorInput["kind"]; status?: number; code?: string; streamDropped?: boolean };
type Consume = (
  response: Response,
  onEvent: (name: string, data: Record<string, unknown>) => void,
  createError: (input: StreamErrorInput) => Error
) => Promise<Record<string, unknown>>;

async function consume(): Promise<Consume> {
  const url=pathToFileURL(join(process.cwd(),"src/frontend/run-event-stream.js")).href;
  return (await import(`${url}?run-event-stream`)).consumeRunEventStream as Consume;
}

const createError=(input:StreamErrorInput)=>Object.assign(new Error(input.message||input.kind),{kind:input.kind});
const encoder=new TextEncoder();
const run=(runId:string,extra:Record<string,unknown>={})=>({runId,recordId:"fixture-session",status:"running",...extra});
const event=(name:string,value:Record<string,unknown>,ending="\n\n")=>`event: ${name}\ndata: ${JSON.stringify(value)}${ending}`;

function response(chunks:Array<string|Uint8Array>,options:{status?:number,contentType?:string}={}) {
  let index=0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller){
      const chunk=chunks[index++];
      if(chunk===undefined){controller.close();return;}
      controller.enqueue(typeof chunk==="string"?encoder.encode(chunk):chunk);
    }
  }),{status:options.status??200,headers:{"content-type":options.contentType??"text/event-stream; charset=utf-8"}});
}

test("stays a transport-only module without UI, storage, or localization dependencies",async()=>{
  const source=await readFile("src/frontend/run-event-stream.js","utf8");
  assert.doesNotMatch(source,/^import\s/m);
  assert.doesNotMatch(source,/\bdocument\b|\bwindow\b|localStorage|sessionStorage|composer|i18n|\bt\(/);
});

test("dispatches snapshots, updates, unknown events, and the authoritative completed terminal",async()=>{
  const consumeEvents=await consume(),seen:Array<[string,Record<string,unknown>]>=[];
  const terminal=await consumeEvents(response([
    ": heartbeat\n\ndata:\n\nevent: ignored\ndata:   \n\n",
    event("run.snapshot",run("fixture-run",{sequence:1,stream:{text:"preview one"}})),
    event("run.preview",run("fixture-run",{sequence:2,stream:{text:"preview two"}})),
    event("run.updated",run("fixture-run",{sequence:3,status:"committing"})),
    event("run.completed",run("fixture-run",{sequence:4,status:"running",revision:"fixture-revision"}))
  ]),(name,data)=>seen.push([name,data]),createError);

  assert.deepEqual(seen.map(([name,data])=>[name,data.sequence]),[
    ["run.snapshot",1],["run.preview",2],["run.updated",3],["run.completed",4]
  ]);
  assert.deepEqual(terminal,run("fixture-run",{sequence:4,status:"completed",revision:"fixture-revision"}));
});

test("normalizes each terminal event name to its authoritative status",async()=>{
  const consumeEvents=await consume();
  for(const [name,status] of [["run.completed","completed"],["run.failed","failed"],["run.aborted","aborted"]] as const){
    const terminal=await consumeEvents(response([event(name,run(name,{status:"running"}))]),()=>{},createError);
    assert.equal(terminal.status,status,name);
  }
});

test("decodes split UTF-8 and accepts CRLF, bare CR, blank frames, and split delimiters",async()=>{
  const consumeEvents=await consume(),seen:Array<[string,Record<string,unknown>]>=[];
  const first=`\r\nevent: run.snapshot\r\ndata: ${JSON.stringify(run("utf8",{stream:{text:"虚构预览🙂"}}))}\r`;
  const middle=`\n\r\nevent: run.updated\rdata: ${JSON.stringify(run("utf8",{sequence:2}))}\r\revent: run.completed\ndata: ${JSON.stringify(run("utf8",{sequence:3}))}\n`;
  const bytes=encoder.encode(first+middle+"\n"),emoji=encoder.encode("🙂"),emojiAt=bytes.findIndex((value,index)=>value===emoji[0]&&bytes[index+1]===emoji[1]);
  assert.ok(emojiAt>0);
  const terminal=await consumeEvents(response([
    bytes.slice(0,emojiAt+1),bytes.slice(emojiAt+1,emojiAt+3),bytes.slice(emojiAt+3,bytes.length-1),bytes.slice(bytes.length-1)
  ]),(name,data)=>seen.push([name,data]),createError);

  assert.deepEqual(seen.map(([name])=>name),["run.snapshot","run.updated","run.completed"]);
  assert.deepEqual((seen[0]?.[1].stream as {text:string}).text,"虚构预览🙂");
  assert.equal(terminal.status,"completed");
});

test("preserves the legacy concatenation of multiline data and defaults the event name",async()=>{
  const consumeEvents=await consume(),seen:Array<[string,Record<string,unknown>]>=[];
  const payload=JSON.stringify(run("multiline",{sequence:1})),split=payload.indexOf(",");
  const terminalPayload=JSON.stringify(run("multiline",{sequence:2})),terminalSplit=terminalPayload.indexOf(",");
  const terminal=await consumeEvents(response([
    `: comment\nid: 4\nretry: 1000\ndata: ${payload.slice(0,split+1)}\ndata: ${payload.slice(split+1)}\n\n`+
    `event: run.completed\ndata: ${terminalPayload.slice(0,terminalSplit+1)}\ndata: ${terminalPayload.slice(terminalSplit+1)}\n\n`
  ]),(name,data)=>seen.push([name,data]),createError);
  assert.deepEqual(seen.map(([name,data])=>[name,data.sequence]),[["message",1],["run.completed",2]]);
  assert.equal(terminal.status,"completed");
});

test("preserves API envelope status, code, and server message",async()=>{
  const consumeEvents=await consume();
  await assert.rejects(
    consumeEvents(new Response(JSON.stringify({error:{code:"RUN_NOT_FOUND",message:"fictional missing run"}}),{
      status:404,headers:{"content-type":"application/json"}
    }),()=>{},createError),
    (error:StreamError)=>error.kind==="requestFailed"&&error.message==="fictional missing run"&&error.status===404&&error.code==="RUN_NOT_FOUND"&&error.streamDropped===undefined
  );
  await assert.rejects(
    consumeEvents(new Response(JSON.stringify({error:{code:"FIXTURE_FAILURE"}}),{status:500}),()=>{},createError),
    (error:StreamError)=>error.kind==="requestFailed"&&error.status===500&&error.code==="FIXTURE_FAILURE"
  );
});

test("rejects a missing body or non-event-stream content type without marking a drop",async()=>{
  const consumeEvents=await consume();
  for(const value of [
    new Response(null,{status:200,headers:{"content-type":"text/event-stream"}}),
    new Response("{}",{status:200,headers:{"content-type":"application/json"}})
  ])await assert.rejects(consumeEvents(value,()=>{},createError),
    (error:StreamError)=>error.kind==="streamExpected"&&error.streamDropped===undefined);
});

test("marks malformed JSON, callback failures, read failures, and nonterminal EOF as dropped",async()=>{
  const consumeEvents=await consume();
  await assert.rejects(consumeEvents(response(["event: run.updated\ndata: {bad json}\n\n"]),()=>{},createError),
    (error:StreamError)=>error instanceof SyntaxError&&error.streamDropped===true);
  const callbackError=new Error("fictional preview callback failed");
  await assert.rejects(consumeEvents(response([event("run.updated",run("callback"))]),()=>{throw callbackError;},createError),
    (error:StreamError)=>error===callbackError&&error.streamDropped===true);
  const readError=new Error("fictional reader failed");
  const failing=new Response(new ReadableStream<Uint8Array>({start(controller){controller.error(readError);}}),{
    headers:{"content-type":"text/event-stream"}
  });
  await assert.rejects(consumeEvents(failing,()=>{},createError),
    (error:StreamError)=>error===readError&&error.streamDropped===true);
  await assert.rejects(consumeEvents(response([event("run.updated",run("early",{status:"completed"}))]),()=>{},createError),
    (error:StreamError)=>error.kind==="streamEnded"&&error.streamDropped===true);
});

test("rethrows AbortError unchanged and releases the reader lock after every read outcome",async()=>{
  const consumeEvents=await consume();
  for(const mode of ["terminal","eof","bad-json","abort"] as const){
    const stream=new ReadableStream<Uint8Array>({
      start(controller){
        if(mode==="abort"){const error=new Error("cancelled");error.name="AbortError";controller.error(error);return;}
        const body=mode==="terminal"?event("run.completed",run(mode)):mode==="bad-json"?"data: {\n\n":event("run.updated",run(mode));
        controller.enqueue(encoder.encode(body));controller.close();
      }
    });
    if(mode==="abort")await assert.rejects(consumeEvents(new Response(stream,{headers:{"content-type":"text/event-stream"}}),()=>{},createError),
      (error:StreamError)=>error.name==="AbortError"&&error.streamDropped===undefined);
    else if(mode==="terminal")await consumeEvents(new Response(stream,{headers:{"content-type":"text/event-stream"}}),()=>{},createError);
    else await assert.rejects(consumeEvents(new Response(stream,{headers:{"content-type":"text/event-stream"}}),()=>{},createError));
    const reader=stream.getReader();reader.releaseLock();
  }
});

test("cancels a still-open reader after parsing, callback, or abort failure",async()=>{
  const consumeEvents=await consume();
  for(const mode of ["bad-json","callback","abort"] as const){
    let cancelled=false;
    const abortError={name:"AbortError",fixture:"plain object"};
    const stream=new ReadableStream<Uint8Array>({
      start(controller){
        controller.enqueue(encoder.encode(mode==="bad-json"?"data: {bad json}\n\n":event("run.updated",run("callback-cancel"))));
      },
      cancel(){cancelled=true;}
    });
    await assert.rejects(consumeEvents(new Response(stream,{headers:{"content-type":"text/event-stream"}}),()=>{
      if(mode==="callback")throw new Error("fictional callback failure");
      if(mode==="abort")throw abortError;
    },createError),error=>mode!=="abort"||error===abortError);
    assert.equal(cancelled,true,mode);
    const reader=stream.getReader();reader.releaseLock();
  }
});
