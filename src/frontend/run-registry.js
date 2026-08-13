export const RUN_PREFIX="ark-panel:run:v1:";

const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

function invalid(){return new Error("RUN_INVALID")}

/** @param {unknown} value @param {Set<object>} [ancestors] @returns {unknown} */
function clone(value,ancestors=new Set()){
  if(value===undefined||value===null||typeof value==="string"||typeof value==="boolean")return value;
  if(typeof value==="number"){if(Number.isFinite(value))return value;throw invalid()}
  if(typeof value!=="object")throw invalid();
  if(ancestors.has(value))throw invalid();
  ancestors.add(value);
  try{
    if(value instanceof Error){
      if(Object.getOwnPropertySymbols(value).length)throw invalid();
      const copied=new Error(value.message);copied.name=value.name;
      for(const key of Object.keys(value)){
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(!descriptor||!("value" in descriptor))throw invalid();
        Object.defineProperty(copied,key,{value:clone(descriptor.value,ancestors),enumerable:true,writable:true,configurable:true});
      }
      return copied;
    }
    if(Array.isArray(value)){
      const keys=Reflect.ownKeys(value);
      if(keys.some(item=>typeof item!=="string"||item!=="length"&&(!/^\d+$/.test(item)||String(Number(item))!==item||Number(item)>=value.length))||Object.keys(value).length!==value.length)throw invalid();
      return value.map(item=>{if(item===undefined)throw invalid();return clone(item,ancestors)});
    }
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)throw invalid();
    const copied=prototype===null?Object.create(null):{};
    for(const key of Reflect.ownKeys(value)){
      if(typeof key!=="string")throw invalid();
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor?.enumerable||!("value" in descriptor))throw invalid();
      Object.defineProperty(copied,key,{value:clone(descriptor.value,ancestors),enumerable:true,writable:true,configurable:true});
    }
    return copied;
  }finally{ancestors.delete(value)}
}

/**
 * Owns the browser's in-memory run index and additive v1 persistence shape.
 * Transport recovery, UI updates, and composer ownership remain with app.js.
 * @param {{storage:Pick<Storage,"getItem"|"setItem"|"removeItem"|"key"|"length">,prefix?:string}} options
 */
export function createRunRegistry({storage,prefix=RUN_PREFIX}){
  /** @type {Map<string,Record<string,unknown>>} */
  const runs=new Map();
  const key=recordId=>`${prefix}${encodeURIComponent(recordId)}`;

  /** @param {Record<string,unknown>|null|undefined} value @param {Record<string,unknown>} [fallback] */
  function normalize(value,fallback={}){
    const source=/** @type {Record<string,unknown>} */(clone(value||{})),base=/** @type {Record<string,unknown>} */(clone(fallback));
    const nested=source.data;
    const raw=/** @type {Record<string,unknown>} */(nested&&typeof nested==="object"&&!Array.isArray(nested)?nested:source);
    const runId=String(raw.runId||raw.id||base.runId||""),recordId=String(raw.recordId||raw.sessionId||base.recordId||"");
    return /** @type {Record<string,unknown>} */(clone({...base,...raw,runId,recordId,status:String(raw.status||raw.state||base.status||"accepted"),error:raw.error||base.error,stream:own(raw,"stream")?raw.stream:undefined}));
  }

  /** @param {Record<string,unknown>} run */
  function persist(run){
    if(!run.recordId||!run.runId)return false;
    try{
      storage.setItem(key(String(run.recordId)),JSON.stringify({runId:run.runId,recordId:run.recordId,agentId:run.agentId,status:run.status,createPhase:run.createPhase,submittedDraft:run.submittedDraft,submittedRevision:run.submittedRevision,submittedAttachmentIds:run.submittedAttachmentIds,submittedRequestOutputs:run.submittedRequestOutputs}));
      return true;
    }catch{return false}
  }

  /** @param {string} recordId */
  function forget(recordId){try{storage.removeItem(key(recordId))}catch{}}
  /** @param {string} recordId */
  function deleteRun(recordId){runs.delete(recordId);forget(recordId)}

  /** @param {Record<string,unknown>} value */
  function remember(value){
    const run=normalize(value);
    if(!run.runId||!run.recordId)throw new Error("RUN_INVALID");
    run.storageAvailable=run.storageAvailable!==false&&persist(run);
    runs.set(String(run.recordId),run);
    return /** @type {Record<string,unknown>} */(clone(run));
  }

  /** @param {Record<string,unknown>} value @param {Record<string,unknown>|undefined} local */
  function rememberServer(value,local){
    const server=normalize(value),same=Boolean(local&&local.runId===server.runId&&local.recordId===server.recordId);
    return remember({...normalize(server,same?local:undefined),createPhase:"acknowledged"});
  }

  function readStoredEntries(){
    const entries=[];
    for(let index=0;index<storage.length;index++){
      const storedKey=storage.key(index);
      if(storedKey?.startsWith(prefix))entries.push({key:storedKey,raw:storage.getItem(storedKey)});
    }
    return entries;
  }

  return{
    key,normalize,
    get(recordId){const run=runs.get(recordId);return run?/** @type {Record<string,unknown>} */(clone(run)):undefined},
    has(recordId){return runs.has(recordId)},
    remember,rememberServer,forget,delete:deleteRun,readStoredEntries
  };
}
