import {inspectStoredRuns} from "./run-recovery-policy.js";

/**
 * Coordinates browser run recovery without owning transport, storage, or UI.
 * @param {{
 *   registry:{readStoredEntries:()=>Array<{key:string,raw:string|null}>,key:(recordId:string)=>string,get:(recordId:string)=>Record<string,unknown>|undefined},
 *   removeStoredKey:(key:string)=>void,
 *   rememberLocal:(value:Record<string,unknown>)=>Record<string,unknown>,
 *   reconcileCreation:(run:Record<string,unknown>)=>unknown,
 *   getActive:(recordId:string)=>Promise<unknown>,
 *   rememberAccepted:(snapshot:unknown,local:undefined)=>Record<string,unknown>,
 *   settle:(run:Record<string,unknown>)=>Promise<boolean>,
 *   watch:(run:Record<string,unknown>)=>unknown
 * }} options
 */
export function createRunBootstrap({registry,removeStoredKey,rememberLocal,reconcileCreation,getActive,rememberAccepted,settle,watch}){
  function recoverStored(){
    try{
      const inspected=inspectStoredRuns(registry.readStoredEntries(),recordId=>registry.key(recordId));
      for(const remove of inspected.remove)removeStoredKey(remove);
      for(const value of inspected.runs){const run=rememberLocal(value);void reconcileCreation(run)}
    }catch{}
  }

  /** @param {string} recordId */
  async function reconcileSession(recordId){
    const local=registry.get(recordId);
    if(local){void reconcileCreation(local);return}
    try{
      const snapshot=await getActive(recordId);
      if(snapshot){const run=rememberAccepted(snapshot,undefined);if(!await settle(run))void watch(run)}
    }catch{}
  }

  return{recoverStored,reconcileSession};
}
