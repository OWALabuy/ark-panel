const terminalEvents=new Map([
  ["run.completed","completed"],
  ["run.failed","failed"],
  ["run.aborted","aborted"]
]);

/**
 * @typedef {"requestFailed"|"streamExpected"|"streamEnded"} RunEventStreamErrorKind
 * @typedef {{kind:RunEventStreamErrorKind, message?:string}} RunEventStreamErrorInput
 */

/** @param {unknown} error */
function dropped(error){
  if(error instanceof Error)return Object.assign(error,{streamDropped:true});
  return Object.assign(new Error(String(error)),{streamDropped:true});
}

/**
 * Consume one run event stream and return its authoritative terminal payload.
 *
 * @param {Response} response
 * @param {(name:string, data:Record<string,unknown>)=>void} onEvent
 * @param {(input:RunEventStreamErrorInput)=>Error} createError
 * @returns {Promise<Record<string,unknown>>}
 */
export async function consumeRunEventStream(response,onEvent,createError){
  if(!response.ok){
    const value=/** @type {{error?:{code?:string,message?:string}}} */(await response.json());
    throw Object.assign(createError({kind:"requestFailed",message:value.error?.message}),{
      status:response.status,
      code:value.error?.code
    });
  }
  if(!response.body||!response.headers.get("content-type")?.startsWith("text/event-stream")){
    throw createError({kind:"streamExpected"});
  }

  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer="",lineStart=0,frame=[],terminal=/** @type {Record<string,unknown>|null} */(null);
  const dispatch=()=>{
    let name="message";
    const data=[];
    for(const line of frame){
      if(line.startsWith("event:"))name=line.slice(6).trim();
      else if(line.startsWith("data:"))data.push(line.slice(5).trim());
    }
    frame=[];
    const serialized=data.join("");
    if(!serialized)return;
    const parsed=/** @type {Record<string,unknown>} */(JSON.parse(serialized));
    onEvent(name,parsed);
    const status=terminalEvents.get(name);
    if(status)terminal={...parsed,status};
  };
  const parseLines=(done=false)=>{
    for(let index=lineStart;index<buffer.length;index+=1){
      const character=buffer[index];
      if(character!=="\n"&&character!=="\r")continue;
      if(character==="\r"&&index+1===buffer.length&&!done)break;
      const line=buffer.slice(lineStart,index);
      if(character==="\r"&&buffer[index+1]==="\n")index+=1;
      lineStart=index+1;
      if(line==="")dispatch();
      else frame.push(line);
    }
    if(lineStart>0){
      buffer=buffer.slice(lineStart);
      lineStart=0;
    }
  };

  try{
    for(;;){
      const {done,value}=await reader.read();
      buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
      parseLines(done);
      if(done)break;
    }
  }catch(error){
    try{await reader.cancel();}catch{}
    if(typeof error==="object"&&error!==null&&"name" in error&&error.name==="AbortError")throw error;
    throw dropped(error);
  }finally{
    reader.releaseLock();
  }
  if(!terminal)throw dropped(createError({kind:"streamEnded"}));
  return terminal;
}
