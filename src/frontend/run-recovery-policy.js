const RUN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_STATUSES=new Set(["accepted","running","materializing","committing","committed","aborting","completed","failed","aborted"]);

/**
 * Validate the additive v1 persisted-run shape before it can influence a
 * recovery request. The caller owns JSON parsing and the key namespace.
 * @param {unknown} value
 * @param {string} key
 * @param {(recordId:string)=>string} runKey
 */
export function validStoredRun(value,key,runKey){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const run=/** @type {Record<string,unknown>} */(value),runId=run.runId,recordId=run.recordId,attachments=run.submittedAttachmentIds;
  return typeof runId==="string"&&RUN_ID.test(runId)&&typeof recordId==="string"&&Boolean(recordId)&&key===runKey(recordId)
    &&(run.status===undefined||typeof run.status==="string"&&RUN_STATUSES.has(run.status))
    &&(run.createPhase===undefined||run.createPhase==="provisional"||run.createPhase==="acknowledged")
    &&(run.agentId===undefined||typeof run.agentId==="string")
    &&(run.submittedDraft===undefined||typeof run.submittedDraft==="string")
    &&(run.submittedRevision===undefined||typeof run.submittedRevision==="string")
    &&(attachments===undefined||Array.isArray(attachments)&&attachments.length<=10&&attachments.every(item=>typeof item==="string"))
    &&(run.submittedRequestOutputs===undefined||typeof run.submittedRequestOutputs==="boolean");
}

/**
 * A POST is safe only after both server lookups proved absence. This helper
 * decides whether the persisted client evidence is complete enough to retry.
 * @param {Record<string,unknown>} run
 */
export function retryableStoredCreation(run){
  const attachments=run.submittedAttachmentIds;
  return run.storageAvailable!==false&&typeof run.runId==="string"&&RUN_ID.test(run.runId)
    &&typeof run.recordId==="string"&&Boolean(run.recordId)&&run.status==="accepted"
    &&(run.createPhase==="provisional"||run.createPhase===undefined)&&typeof run.submittedDraft==="string"
    &&(run.submittedRevision===undefined||typeof run.submittedRevision==="string")
    &&Array.isArray(attachments)&&attachments.length<=10&&attachments.every(item=>typeof item==="string")
    &&typeof run.submittedRequestOutputs==="boolean"&&Boolean(run.submittedDraft.trim()||attachments.length);
}

/** @param {unknown} value @param {string} recordId @param {string|undefined} [runId] */
export function validServerRun(value,recordId,runId){
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const snapshot=/** @type {Record<string,unknown>} */(value);
  return snapshot.recordId===recordId&&typeof snapshot.runId==="string"&&RUN_ID.test(snapshot.runId)
    &&(runId===undefined||snapshot.runId===runId)&&typeof snapshot.status==="string"&&RUN_STATUSES.has(snapshot.status);
}

/** @param {Record<string,unknown>} run @param {unknown} active */
export function missingRunAction(run,active){
  if(active===null)return retryableStoredCreation(run)?"create":"discard";
  return validServerRun(active,String(run.recordId))?"watch":"retry";
}

/** @param {unknown} value */
export function uncertainCreateError(value){
  const error=/** @type {{status?:unknown,code?:unknown}|null} */(value&&typeof value==="object"?value:null),status=Number(error?.status);
  return !Number.isInteger(status)||status>=500||status===408||status===429||error?.code==="SESSION_BUSY";
}

/** @param {{createPhase?:unknown,storageAvailable?:unknown}} run */
export function acknowledgedStorageAction(run){return run.createPhase==="acknowledged"&&run.storageAvailable===false?"remove":"keep"}

/**
 * Recover one persisted run using only normalized API results. The orchestration
 * makes the read-before-write sequence directly testable outside the DOM.
 * @param {Record<string,unknown>} run
 * @param {{getRun:(runId:string)=>Promise<unknown>,getActive:(recordId:string)=>Promise<unknown>,create:()=>Promise<unknown>}} operations
 * @returns {Promise<{action:"watch"|"created"|"discard"|"retry"|"failed",snapshot?:unknown,error?:unknown,stage?:"observe"|"create"}>}
 */
export async function recoverPersistedRun(run,operations){
  try{
    const snapshot=await operations.getRun(String(run.runId));
    return validServerRun(snapshot,String(run.recordId),String(run.runId))?{action:"watch",snapshot}:{action:"retry",stage:"observe"};
  }
  catch(error){
    const typed=/** @type {{status?:unknown,code?:unknown}} */(error&&typeof error==="object"?error:{});
    if(typed.status!==404||typed.code!=="RUN_NOT_FOUND")return{action:"retry",error,stage:"observe"};
  }
  let active;
  try{active=await operations.getActive(String(run.recordId))}catch(error){return{action:"retry",error,stage:"observe"}}
  const action=missingRunAction(run,active);
  if(action==="watch")return{action,snapshot:active};
  if(action==="discard")return{action};
  if(action==="retry")return{action,stage:"observe"};
  try{
    const snapshot=await operations.create();
    return validServerRun(snapshot,String(run.recordId),String(run.runId))?{action:"created",snapshot}:{action:"retry",stage:"create"};
  }
  catch(error){return{action:uncertainCreateError(error)?"retry":"failed",error,stage:"create"}}
}

/**
 * Parse the entire run namespace before starting any asynchronous recovery.
 * Duplicate run ids are deleted together so neither record can claim them.
 * @param {Array<{key:string,raw:string|null}>} entries
 * @param {(recordId:string)=>string} runKey
 */
export function inspectStoredRuns(entries,runKey){
  const valid=[],remove=[],byRunId=new Map();
  for(const entry of entries){
    try{
      const value=JSON.parse(entry.raw||"null");
      if(!validStoredRun(value,entry.key,runKey))throw new Error("RUN_STORAGE_INVALID");
      valid.push({key:entry.key,value});
      const keys=byRunId.get(value.runId)||[];keys.push(entry.key);byRunId.set(value.runId,keys);
    }catch{remove.push(entry.key)}
  }
  const collisions=new Set([...byRunId].filter(([,keys])=>keys.length>1).map(([runId])=>runId));
  for(const entry of valid)if(collisions.has(entry.value.runId))remove.push(entry.key);
  return{runs:valid.filter(entry=>!collisions.has(entry.value.runId)).map(entry=>entry.value),remove};
}
