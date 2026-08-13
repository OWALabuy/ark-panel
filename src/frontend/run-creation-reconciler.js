import {recoverPersistedRun} from "./run-recovery-policy.js";

/**
 * Coordinate recovery of provisional run creation without owning registry,
 * transport, composer, or presentation state.
 * @param {{
 *   current:(recordId:string)=>Record<string,unknown>|undefined,
 *   merge:(current:Record<string,unknown>,run:Record<string,unknown>)=>Record<string,unknown>,
 *   getRun:(runId:string)=>Promise<unknown>,
 *   getActive:(recordId:string)=>Promise<unknown>,
 *   create:(run:Record<string,unknown>)=>Promise<unknown>,
 *   rememberAccepted:(snapshot:unknown,run:Record<string,unknown>)=>Record<string,unknown>,
 *   consumeAccepted:(run:Record<string,unknown>)=>void,
 *   settle:(run:Record<string,unknown>)=>Promise<boolean>,
 *   watch:(run:Record<string,unknown>)=>unknown,
 *   discard:(run:Record<string,unknown>)=>void,
 *   onMissing:(run:Record<string,unknown>)=>void,
 *   onFailed:(run:Record<string,unknown>,error:unknown,retry:()=>Promise<void>)=>void,
 *   onRetrying:(stage:"observe"|"create",run:Record<string,unknown>,error:unknown)=>void,
 *   delay:(milliseconds:number)=>Promise<void>
 * }} actions
 */
export function createRunCreationReconciler(actions){
  /** @type {Map<string,Promise<void>>} */
  const reconcilers=new Map();

  /** @param {Record<string,unknown>} value */
  function reconcile(value){
    let run=value;
    const runId=String(run.runId);
    const existing=reconcilers.get(runId);
    if(existing)return existing;
    const task=(async()=>{
      for(;;){
        const current=actions.current(String(run.recordId));
        if(current&&current.runId===run.runId)run=actions.merge(current,run);
        const result=await recoverPersistedRun(run,{
          getRun:actions.getRun,
          getActive:actions.getActive,
          create:()=>actions.create(run)
        });
        if(result.action==="watch"||result.action==="created"){
          const accepted=actions.rememberAccepted(result.snapshot,run);
          actions.consumeAccepted(accepted);
          if(!await actions.settle(accepted))void actions.watch(accepted);
          return;
        }
        if(result.action==="discard"){
          actions.discard(run);
          actions.onMissing(run);
          return;
        }
        if(result.action==="failed"){
          actions.discard(run);
          if(reconcilers.get(runId)===task)reconcilers.delete(runId);
          actions.onFailed(run,result.error,()=>reconcile(run));
          return;
        }
        actions.onRetrying(result.stage||"observe",run,result.error);
        await actions.delay(1500);
      }
    })().finally(()=>{if(reconcilers.get(runId)===task)reconcilers.delete(runId)});
    reconcilers.set(runId,task);
    return task;
  }

  return{reconcile};
}
