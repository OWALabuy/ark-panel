/** @typedef {{agentId?:unknown,sessionId?:unknown}} SubmissionScope */
/** @typedef {{agentId:string,sessionId:string,revision:string}} CreatedSession */
/** @typedef {{token?:unknown,scope?:unknown}} SubmissionReceipt */
/** @typedef {{id?:unknown,attachmentId?:unknown}} UploadedAttachment */
/** @typedef {Record<string,unknown>} ClientRun */

/** @param {string} code */
function submissionError(code){return Object.assign(new Error(code),{code})}

/** @param {SubmissionScope|null|undefined} value */
function normalizedScope(value){return{agentId:String(value?.agentId||""),sessionId:String(value?.sessionId||"")}}

/** @param {unknown} value @param {string} expectedAgentId @returns {CreatedSession} */
function normalizedCreatedSession(value,expectedAgentId){
  const candidate=/** @type {{agentId?:unknown,sessionId?:unknown,revision?:unknown}|null} */(value&&typeof value==="object"?value:null);
  const agentId=String(candidate?.agentId||""),sessionId=String(candidate?.sessionId||"");
  if(!expectedAgentId||agentId!==expectedAgentId||!sessionId)throw submissionError("SUBMISSION_SESSION_INVALID");
  return{agentId,sessionId,revision:String(candidate?.revision||"")};
}

/** @param {UploadedAttachment} value */
function uploadedId(value){
  const id=String(value?.attachmentId||value?.id||"");
  if(!id)throw submissionError("ATTACHMENT_INVALID_RESPONSE");
  return id;
}

/**
 * Coordinate one already-validated generation submission without owning the
 * DOM, localization, transport, run policy, or browser globals.
 *
 * @param {{
 *   composer:{
 *     startSubmission:(scope:SubmissionScope,message:string)=>SubmissionReceipt|null,
 *     createdSession:(scope:SubmissionScope)=>unknown,
 *     rememberCreatedSession:(from:SubmissionScope,to:CreatedSession)=>boolean,
 *     promoteSubmission:(receipt:SubmissionReceipt,from:SubmissionScope,to:SubmissionScope)=>SubmissionReceipt|false,
 *     readOutputIntent:(scope:SubmissionScope)=>boolean,
 *     uploadSubmission:(receipt:SubmissionReceipt,recordId:string,upload:(file:File)=>Promise<UploadedAttachment|null|undefined>)=>Promise<readonly UploadedAttachment[]>,
 *     commitSubmission:(receipt:SubmissionReceipt,runId:string,attachmentIds:Iterable<string>)=>boolean,
 *     finishSubmission:(receipt:SubmissionReceipt)=>boolean
 *   },
 *   createSession:(input:{agentId:string,title:string})=>Promise<unknown>,
 *   onSessionPromoted:(created:CreatedSession)=>Promise<{revision?:unknown}|void>|{revision?:unknown}|void,
 *   uploadAttachment:(recordId:string,file:File)=>Promise<UploadedAttachment|null|undefined>,
 *   randomUUID:()=>unknown,
 *   rememberProvisional:(run:ClientRun)=>ClientRun,
 *   createRun:(request:{recordId:string,runId:string,message:string,revision:string|undefined,attachmentIds:string[],requestOutputs:boolean})=>Promise<unknown>,
 *   rememberAccepted:(snapshot:unknown,provisional:ClientRun)=>ClientRun,
 *   consumeAccepted:(run:ClientRun)=>void,
 *   settle:(run:ClientRun)=>Promise<boolean>,
 *   watch:(run:ClientRun)=>unknown,
 *   discard:(run:ClientRun)=>void,
 *   isUncertainCreateError:(error:unknown)=>boolean,
 *   reconcile:(run:ClientRun)=>unknown,
 *   onSubmissionChanged:(scope:SubmissionScope)=>void
 * }} ports
 */
export function createGenerationSubmissionCoordinator({composer,createSession,onSessionPromoted,uploadAttachment,randomUUID,rememberProvisional,createRun,rememberAccepted,consumeAccepted,settle,watch,discard,isUncertainCreateError,reconcile,onSubmissionChanged}){
  /**
   * `startSubmission` deliberately runs before this async function reaches its
   * first await, so the caller observes the composer lock synchronously.
   * @param {{scope:SubmissionScope,message:unknown,revision?:unknown,requestOutputs?:unknown,sessionTitle?:unknown}} input
   */
  async function submit(input){
    let scope=normalizedScope(input?.scope),message=String(input?.message??""),revision=String(input?.revision||""),requestOutputs=input?.requestOutputs===true;
    let receipt=composer.startSubmission(scope,message);
    if(!receipt)return Object.freeze({kind:"ignored",scope,recordId:scope.sessionId});
    onSubmissionChanged(scope);

    /** @param {"session"|"promotion"|"upload"|"commit"} stage @param {unknown} error */
    function finishFailed(stage,error){
      composer.finishSubmission(receipt||{});onSubmissionChanged(scope);
      return Object.freeze({kind:"failed",stage,scope,recordId:scope.sessionId,error});
    }

    if(!scope.sessionId){
      const sourceScope=scope,agentId=scope.agentId;
      /** @type {CreatedSession} */
      let created;
      try{
        if(!agentId)throw submissionError("SUBMISSION_SESSION_INVALID");
        const remembered=composer.createdSession(sourceScope);
        if(remembered)created=normalizedCreatedSession(remembered,agentId);
        else{
          created=normalizedCreatedSession(await createSession({agentId,title:String(input?.sessionTitle||"")}),agentId);
          if(!composer.rememberCreatedSession(sourceScope,created))throw submissionError("SUBMISSION_SESSION_INVALID");
        }
      }catch(error){return finishFailed("session",error)}

      try{
        const targetScope=normalizedScope(created),promoted=composer.promoteSubmission(receipt,sourceScope,targetScope);
        if(!promoted)throw submissionError("SUBMISSION_PROMOTION_FAILED");
        receipt=promoted;scope=targetScope;revision=created.revision;
        requestOutputs=composer.readOutputIntent(scope)===true;
        const refreshed=await onSessionPromoted(created);
        if(refreshed&&typeof refreshed==="object"&&"revision" in refreshed)revision=String(refreshed.revision||"");
      }catch(error){return finishFailed("promotion",error)}
    }

    /** @type {string[]} */
    let attachmentIds;
    try{
      const uploaded=await composer.uploadSubmission(receipt,scope.sessionId,file=>uploadAttachment(scope.sessionId,file));
      if(!Array.isArray(uploaded))throw submissionError("ATTACHMENT_INVALID_RESPONSE");
      attachmentIds=uploaded.map(uploadedId);
    }catch(error){return finishFailed("upload",error)}

    let runId;
    try{
      runId=String(randomUUID()||"");
      if(!runId||!composer.commitSubmission(receipt,runId,attachmentIds))throw submissionError("SUBMISSION_COMMIT_FAILED");
    }catch(error){return finishFailed("commit",error)}

    const provisional=rememberProvisional({
      runId,recordId:scope.sessionId,agentId:scope.agentId,status:"accepted",createPhase:"provisional",
      submittedDraft:message,...revision?{submittedRevision:revision}:{},submittedAttachmentIds:attachmentIds,submittedRequestOutputs:requestOutputs
    });
    try{
      const accepted=rememberAccepted(await createRun({recordId:scope.sessionId,runId,message,revision:revision||undefined,attachmentIds,requestOutputs}),provisional);
      consumeAccepted(accepted);
      if(!await settle(accepted))void watch(accepted);
      return Object.freeze({kind:"accepted",scope,recordId:scope.sessionId,run:accepted});
    }catch(error){
      if(isUncertainCreateError(error)){
        void reconcile(provisional);
        return Object.freeze({kind:"reconciling",scope,recordId:scope.sessionId,run:provisional,error});
      }
      discard(provisional);
      return Object.freeze({kind:"failed",stage:"create",scope,recordId:scope.sessionId,error});
    }
  }

  return Object.freeze({submit});
}
