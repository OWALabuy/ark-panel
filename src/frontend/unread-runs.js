export const UNREAD_RUNS_KEY="ark-panel:unread-runs:v1";

/** @typedef {{agentId:string,status:"completed"|"failed"}} UnreadRun */

/** @param {UnreadRun} value */
function snapshot(value){return Object.freeze({...value})}

/**
 * Owns persisted unread terminal-run state without importing browser globals.
 * @param {{storage:Pick<Storage,"getItem"|"setItem"|"removeItem">}} dependencies
 */
export function createUnreadRunStore({storage}){
  /** @type {Map<string,UnreadRun>} */ let runs=new Map();

  function read(){
    try{
      const value=JSON.parse(storage.getItem(UNREAD_RUNS_KEY)||"{}"),entries=value&&typeof value==="object"&&!Array.isArray(value)?Object.entries(value):[];
      return new Map(entries.flatMap(([recordId,item])=>{
        const candidate=/** @type {{agentId?:unknown,status?:unknown}|null} */(item),agentId=String(candidate?.agentId||""),status=String(candidate?.status||"");
        return recordId&&agentId&&(status==="completed"||status==="failed")?[[String(recordId),{agentId,status}]]:[];
      }));
    }catch{return new Map()}
  }

  function persist(){try{if(runs.size)storage.setItem(UNREAD_RUNS_KEY,JSON.stringify(Object.fromEntries(runs)));else storage.removeItem(UNREAD_RUNS_KEY)}catch{}}

  function reload(){runs=read()}

  /** @param {unknown} recordId */
  function get(recordId){const value=runs.get(String(recordId||""));return value?snapshot(value):undefined}

  function values(){return Object.freeze([...runs.values()].map(snapshot))}

  /**
   * @param {{recordId?:unknown,agentId?:unknown,status?:unknown}} run
   * @param {{activeRecordId?:unknown,documentHidden?:unknown,fallbackAgentId?:unknown}} context
   */
  function mark(run,context){
    const recordId=String(run?.recordId||""),agentId=String(run?.agentId||context?.fallbackAgentId||""),status=String(run?.status||""),activeRecordId=String(context?.activeRecordId||"");
    if(!recordId||!agentId||(status!=="completed"&&status!=="failed"))return false;
    if(activeRecordId===recordId&&!context?.documentHidden)return false;
    runs.set(recordId,{agentId,status});persist();return true;
  }

  /** @param {unknown} recordId */
  function clear(recordId){if(!runs.delete(String(recordId||"")))return false;persist();return true}

  reload();
  return Object.freeze({
    key:UNREAD_RUNS_KEY,
    get size(){return runs.size},
    get,values,mark,clear,reload
  });
}
