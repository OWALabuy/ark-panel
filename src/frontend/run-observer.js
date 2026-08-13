/** @typedef {{runId:string, recordId:string, status?:string, [key:string]:unknown}} ObservedRun */
/** @typedef {{status?:number}} StatusError */

/**
 * Coordinates snapshot queries and SSE observation for acknowledged runs.
 * Persistence, terminal effects, UI feedback, and transport details are injected.
 * @param {{
 *   query:(run:ObservedRun)=>Promise<unknown>,
 *   openEvents:(run:ObservedRun)=>Promise<unknown>,
 *   consumeEvents:(response:unknown,onEvent:(name:string,data:Record<string,unknown>)=>void)=>Promise<unknown>,
 *   remember:(value:unknown,local:ObservedRun)=>ObservedRun,
 *   settle:(run:ObservedRun)=>Promise<boolean>,
 *   discard:(run:ObservedRun)=>void,
 *   onMissing:(run:ObservedRun)=>void,
 *   onConnectionLost:(run:ObservedRun,error:unknown)=>void,
 *   delay:(milliseconds:number)=>Promise<void>
 * }} options
 */
export function createRunObserver({query,openEvents,consumeEvents,remember,settle,discard,onMissing,onConnectionLost,delay}){
  /** @type {Map<string,Promise<void>>} */
  const watchers=new Map();

  /** @param {ObservedRun} value */
  function watch(value){
    const initial=value,runId=initial.runId,existing=watchers.get(runId);
    if(existing)return existing;
    const watcher=(async()=>{
      let run=initial;
      for(;;){
        try{
          run=remember(await query(run),run);
          if(await settle(run))return;
          const response=await openEvents(run);
          const terminal=await consumeEvents(response,(name,data)=>{
            const status=name==="run.completed"||name==="run.failed"||name==="run.aborted"?name.slice(4):undefined;
            run=remember(status?{...data,status}:data,run);
          });
          run=remember(terminal,run);
          if(await settle(run))return;
        }catch(error){
          if(/** @type {StatusError|null|undefined} */(error)?.status===404){
            discard(run);
            onMissing(run);
            return;
          }
          onConnectionLost(run,error);
          await delay(1500);
        }
      }
    })().finally(()=>watchers.delete(runId));
    watchers.set(runId,watcher);
    return watcher;
  }

  return{watch};
}
