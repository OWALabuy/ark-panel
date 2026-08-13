import {acknowledgedStorageAction} from "./run-recovery-policy.js";

const TERMINAL_STATUSES=new Set(["completed","failed","aborted"]);

/**
 * Owns the browser run lifecycle while transport and presentation stay in app.js.
 * @param {{
 *   registry:{normalize:(value:Record<string,unknown>|null|undefined,fallback?:Record<string,unknown>)=>Record<string,unknown>,get:(recordId:string)=>Record<string,unknown>|undefined,remember:(run:Record<string,unknown>)=>Record<string,unknown>,rememberServer:(run:Record<string,unknown>,local?:Record<string,unknown>)=>Record<string,unknown>,forget:(recordId:string)=>void,delete:(recordId:string)=>void},
 *   composer:{discardCompletionOwnership:(runId:unknown)=>unknown,complete:(scope:{agentId:string,sessionId:string},run:Record<string,unknown>,currentDraft:unknown)=>unknown},
 *   activeContext:()=>{agentId:string,recordId:string},
 *   currentDraft:(scope:{agentId:string,sessionId:string})=>unknown,
 *   invalidRunError:()=>Error,
 *   requestAbort:(run:Record<string,unknown>)=>Promise<unknown>,
 *   watch:(run:Record<string,unknown>)=>unknown,
 *   events:{remembered:(run:Record<string,unknown>)=>void,discarded:(run:Record<string,unknown>)=>void,terminal:(run:Record<string,unknown>)=>void,terminalActive:(run:Record<string,unknown>)=>void,failedActive:(run:Record<string,unknown>)=>void,completedActive:(run:Record<string,unknown>)=>Promise<void>,settled:(run:Record<string,unknown>)=>void,abortUnknown:(run:Record<string,unknown>,error:unknown)=>void}
 * }} options
 */
export function createRunController({registry,composer,activeContext,currentDraft,invalidRunError,requestAbort,watch,events}){
  const isTerminal=status=>TERMINAL_STATUSES.has(String(status));

  /** @param {Record<string,unknown>|null|undefined} value @param {Record<string,unknown>} [fallback] */
  const normalize=(value,fallback={})=>registry.normalize(value,fallback);
  /** @param {string} recordId */
  const current=recordId=>registry.get(recordId);

  /** @param {Record<string,unknown>} value */
  function discard(value){
    const run=normalize(value),stored=current(String(run.recordId));
    if(stored?.runId===run.runId)registry.delete(String(run.recordId));else registry.forget(String(run.recordId));
    composer.discardCompletionOwnership(run.runId);
    events.discarded(run);
  }

  /** @param {Record<string,unknown>} value */
  function rememberLocal(value){
    const run=normalize(value),context=activeContext();
    if(!run.runId||!run.recordId)throw invalidRunError();
    run.agentId=run.agentId||context.agentId;
    const remembered=registry.remember(run);
    if(acknowledgedStorageAction(remembered)==="remove")registry.forget(String(remembered.recordId));
    events.remembered(remembered);
    return remembered;
  }

  /** @param {Record<string,unknown>} value @param {Record<string,unknown>|undefined} local */
  function rememberServer(value,local){
    const server=normalize(value),same=Boolean(local&&local.runId===server.runId&&local.recordId===server.recordId);
    if(local&&!same)discard(local);
    const context=activeContext(),candidate=normalize(server,same?local:undefined);
    candidate.agentId=candidate.agentId||context.agentId;
    const remembered=registry.rememberServer(candidate,same?local:undefined);
    if(acknowledgedStorageAction(remembered)==="remove")registry.forget(String(remembered.recordId));
    events.remembered(remembered);
    return remembered;
  }

  /** @param {Record<string,unknown>} value */
  async function settle(value){
    const run=normalize(value);
    if(!isTerminal(run.status))return false;
    registry.delete(String(run.recordId));
    events.terminal(run);
    const context=activeContext(),active=context.recordId===run.recordId;
    if(run.status==="completed"){
      const scope={agentId:String(run.agentId||context.agentId),sessionId:String(run.recordId)};
      composer.complete(scope,run,currentDraft(scope));
      if(active)await events.completedActive(run);
    }else{
      composer.discardCompletionOwnership(run.runId);
      if(active){events.terminalActive(run);if(run.status==="failed")events.failedActive(run)}
    }
    events.settled(run);
    return true;
  }

  /** @param {Record<string,unknown>} value */
  async function abort(value){
    const run=normalize(value);
    rememberLocal({...run,status:"aborting"});
    try{
      const snapshot=rememberLocal(/** @type {Record<string,unknown>} */(await requestAbort(run)));
      if(!await settle(snapshot))void watch(snapshot);
      return{kind:isTerminal(snapshot.status)?"terminal":"watching",run:snapshot};
    }catch(error){
      events.abortUnknown(run,error);
      void watch(run);
      return{kind:"unknown",run,error};
    }
  }

  return Object.freeze({isTerminal,normalize,current,rememberLocal,rememberServer,discard,settle,abort});
}
