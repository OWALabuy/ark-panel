const DRAFT_PREFIX="ark-panel:draft:v1:",OUTPUT_INTENT_PREFIX="ark-panel:request-outputs:v1:";
const MAX_ATTACHMENT_FILES=10,MAX_ATTACHMENT_TOTAL=15*1024*1024,MAX_IMAGE_ATTACHMENT=6*1024*1024,MAX_FILE_ATTACHMENT=5*1024*1024;
const PREVIEW_IMAGE_MIMES=new Set(["image/png","image/jpeg","image/webp"]),UPLOAD_IMAGE_MIMES=new Set([...PREVIEW_IMAGE_MIMES,"image/gif"]);
const ACCEPTED_ATTACHMENT_EXTENSIONS=new Set(["jpg","jpeg","png","gif","webp","txt","md","html","csv","json","pdf","docx","xlsx","pptx","odt","rtf","epub","xml","yaml","yml","tsv"]);

/** @typedef {{agentId?:string|null,sessionId?:string|null}} ComposerScope */
/** @typedef {{id?:string,attachmentId?:string,fileName?:string,mimeType?:string,sizeBytes?:number,recordId:string}} UploadedAttachment */
/** @typedef {{localId:number,file:File,previewUrl?:string,uploaded?:UploadedAttachment}} PendingAttachment */

/** @param {string} code @param {Record<string,unknown>} [details] */
function composerError(code,details={}){return Object.assign(new Error(code),{code,...details})}

/** @param {ComposerScope} scope */
function normalizedScope(scope){return{agentId:String(scope?.agentId||""),sessionId:String(scope?.sessionId||"")}}

/** @param {ComposerScope} scope */
function scopeKey(scope){const{agentId,sessionId}=normalizedScope(scope);return !agentId?"":sessionId?`session:${sessionId}`:`new:${agentId}`}

/** @param {ComposerScope} scope */
function draftKey(scope){const{agentId,sessionId}=normalizedScope(scope);return agentId&&sessionId?`${DRAFT_PREFIX}${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`:""}

/** @param {ComposerScope} scope */
function outputIntentKey(scope){const{agentId,sessionId}=normalizedScope(scope);return !agentId?"":sessionId?`${OUTPUT_INTENT_PREFIX}session:${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`:`${OUTPUT_INTENT_PREFIX}new:${encodeURIComponent(agentId)}`}

/** @param {PendingAttachment} item */
function snapshotItem(item){
  const uploaded=item.uploaded?Object.freeze({...item.uploaded}):undefined;
  return Object.freeze({localId:item.localId,file:item.file,...item.previewUrl?{previewUrl:item.previewUrl}:{},...uploaded?{uploaded}:{}});
}

/**
 * Owns browser-local composer state without importing the DOM, localization,
 * or generation policy. Callers provide every browser capability explicitly.
 * @param {{storage:Pick<Storage,"getItem"|"setItem"|"removeItem">,createObjectURL:(file:File)=>string,revokeObjectURL:(url:string)=>void}} dependencies
 */
export function createComposerState({storage,createObjectURL,revokeObjectURL}){
  /** @type {Map<string,PendingAttachment[]>} */ const pendingByScope=new Map();
  /** @type {Map<string,{value:string,version:number}>} */ const draftsByScope=new Map();
  /** @type {Map<string,boolean>} */ const outputsByScope=new Map();
  /** @type {Map<string,{token:symbol,submittedDraft:string,draftVersion:number,localIds:number[]}>} */ const submissions=new Map();
  /** @type {Map<string,{scope:string,submittedDraft:string,draftVersion:number,localIds:number[],attachmentIds:string[]}>} */ const acceptedSubmissions=new Map();
  /** @type {Map<string,{agentId:string,sessionId:string,revision:string,storage?:{sourceOutput:string|null,targetDraft:string|null,targetOutput:string|null,draftCopies:(string|null)[],outputCopies:(string|null)[]}}>} */ const createdSessions=new Map();
  let nextLocalId=1,nextDraftVersion=1;

  /** @param {string} key */
  function readRaw(key){try{return{ok:true,value:storage.getItem(key)}}catch{return{ok:false,value:null}}}

  /** @param {string} key @param {string|null} value */
  function writeRaw(key,value){
    try{
      if(value===null)storage.removeItem(key);else storage.setItem(key,value);
      return storage.getItem(key)===value;
    }catch{return false}
  }

  /** @param {string} key @param {string} value @param {boolean} changed */
  function rememberDraft(key,value,changed){
    const current=draftsByScope.get(key);
    if(!current||changed)draftsByScope.set(key,{value,version:nextDraftVersion++});
    else current.value=value;
    return draftsByScope.get(key);
  }

  /** @param {ComposerScope} scope */
  function readDraft(scope){
    const scopeId=scopeKey(scope);if(!scopeId)return"";
    const remembered=draftsByScope.get(scopeId);if(remembered)return remembered.value;
    const key=draftKey(scope),stored=key?readRaw(key):{ok:true,value:null},value=stored.ok?stored.value||"":"";
    rememberDraft(scopeId,value,false);return value;
  }

  /** @param {ComposerScope} scope @param {string} value */
  function saveDraft(scope,value){
    const scopeId=scopeKey(scope);if(!scopeId)return false;
    const normalized=String(value),current=draftsByScope.get(scopeId);rememberDraft(scopeId,normalized,!current||current.value!==normalized);
    const key=draftKey(scope);return !key||writeRaw(key,normalized||null);
  }

  /** @param {ComposerScope} scope */
  function currentDraft(scope){return draftsByScope.get(scopeKey(scope))?.value}

  /** @param {ComposerScope} scope */
  function readOutputIntent(scope){const scopeId=scopeKey(scope),key=outputIntentKey(scope);if(!scopeId||!key)return false;const remembered=outputsByScope.get(scopeId);if(remembered!==undefined)return remembered;let enabled=false;try{enabled=storage.getItem(key)==="1"}catch{}outputsByScope.set(scopeId,enabled);return enabled}

  /** @param {ComposerScope} scope @param {boolean} enabled */
  function saveOutputIntent(scope,enabled){const scopeId=scopeKey(scope),key=outputIntentKey(scope);if(!scopeId||!key)return false;outputsByScope.set(scopeId,Boolean(enabled));return writeRaw(key,enabled?"1":null)}

  /** @param {ComposerScope} scope */
  function pending(scope){const key=scopeKey(scope),values=key?pendingByScope.get(key)||[]:[];return Object.freeze(values.map(snapshotItem))}

  /** @param {PendingAttachment} item */
  function release(item){if(!item.previewUrl)return;const url=item.previewUrl;delete item.previewUrl;try{revokeObjectURL(url)}catch{}}

  /** @param {File} file */
  function validate(file){
    const name=String(file?.name||""),type=String(file?.type||""),size=Number(file?.size),extension=name.includes(".")?name.split(".").pop().toLowerCase():"",image=UPLOAD_IMAGE_MIMES.has(type);
    if(type.startsWith("image/")&&!image)throw composerError("ATTACHMENT_UNSUPPORTED",{fileName:name});
    if(!ACCEPTED_ATTACHMENT_EXTENSIONS.has(extension)&&!image)throw composerError("ATTACHMENT_UNSUPPORTED",{fileName:name});
    const limit=image?MAX_IMAGE_ATTACHMENT:MAX_FILE_ATTACHMENT;
    if(!size)throw composerError("ATTACHMENT_EMPTY",{fileName:name});
    if(size>limit)throw composerError("ATTACHMENT_TOO_LARGE",{fileName:name,limitMiB:image?6:5});
  }

  /** @param {ComposerScope} scope @param {Iterable<File>} files */
  function addPending(scope,files){
    const key=scopeKey(scope);if(!key||submissions.has(key))return false;
    const values=pendingByScope.get(key)||[],incoming=[...files];
    if(values.length+incoming.length>MAX_ATTACHMENT_FILES)throw composerError("ATTACHMENT_TOO_MANY",{count:MAX_ATTACHMENT_FILES});
    for(const file of incoming)validate(file);
    if([...values,...incoming.map(file=>({file}))].reduce((sum,item)=>sum+Number(item.file.size),0)>MAX_ATTACHMENT_TOTAL)throw composerError("ATTACHMENT_TOTAL_TOO_LARGE");
    /** @type {PendingAttachment[]} */ const additions=[];
    try{
      for(const file of incoming)additions.push({localId:nextLocalId++,file,...PREVIEW_IMAGE_MIMES.has(file.type)?{previewUrl:createObjectURL(file)}:{}});
    }catch(error){for(const item of additions)release(item);throw error}
    values.push(...additions);if(values.length)pendingByScope.set(key,values);
    return true;
  }

  /** @param {ComposerScope} scope @param {number} localId */
  function removePending(scope,localId){
    const key=scopeKey(scope);if(!key||submissions.has(key))return false;
    const values=pendingByScope.get(key);if(!values)return false;
    const index=values.findIndex(item=>item.localId===localId);if(index<0)return false;
    const[item]=values.splice(index,1);if(item)release(item);if(!values.length)pendingByScope.delete(key);return true;
  }

  /** @param {ComposerScope} scope @param {string} submittedDraft @returns {Readonly<{token:symbol,scope:string}>|null} */
  function startSubmission(scope,submittedDraft){
    const key=scopeKey(scope);if(!key||submissions.has(key))return null;
    const draft=String(submittedDraft),remembered=draftsByScope.get(key),snapshot=remembered?.value===draft?remembered:rememberDraft(key,draft,true);
    const receipt=Object.freeze({token:Symbol(key),scope:key});submissions.set(key,{token:receipt.token,submittedDraft:draft,draftVersion:snapshot?.version||0,localIds:(pendingByScope.get(key)||[]).map(item=>item.localId)});return receipt;
  }

  /** @param {ComposerScope} scope */
  function isSubmitting(scope){const key=scopeKey(scope);return Boolean(key)&&submissions.has(key)}

  /** @param {{token?:unknown,scope?:unknown}} receipt */
  function finishSubmission(receipt){const key=String(receipt?.scope||""),submission=submissions.get(key);if(!submission||submission.token!==receipt?.token)return false;return submissions.delete(key)}

  /** @param {{token?:unknown,scope?:unknown}} receipt @param {string} runId @param {Iterable<unknown>} attachmentIds */
  function commitSubmission(receipt,runId,attachmentIds){
    const key=String(receipt?.scope||""),submission=submissions.get(key),id=String(runId||""),ids=[...attachmentIds].map(String);
    if(!id||!submission||submission.token!==receipt?.token||ids.length!==submission.localIds.length)return false;
    const values=pendingByScope.get(key)||[],byId=new Map(values.map(item=>[item.localId,item]));
    if(submission.localIds.some((localId,index)=>uploadedId(byId.get(localId)?.uploaded)!==ids[index]))return false;
    acceptedSubmissions.set(id,{scope:key,submittedDraft:submission.submittedDraft,draftVersion:submission.draftVersion,localIds:[...submission.localIds],attachmentIds:ids});
    submissions.delete(key);return true;
  }

  /**
   * Latch the one session already created for a new-agent composer. The latch
   * intentionally stays in memory when storage promotion fails: an explicit
   * retry reuses this record instead of creating another empty session.
   * @param {ComposerScope} from @param {ComposerScope & {revision?:unknown}} to
   */
  function rememberCreatedSession(from,to){
    const source=normalizedScope(from),target=normalizedScope(to),fromKey=scopeKey(source),toKey=scopeKey(target);
    if(!fromKey||!toKey||source.sessionId||!target.sessionId||source.agentId!==target.agentId)return false;
    const existing=createdSessions.get(fromKey),revision=String(to?.revision||"");
    if(existing)return existing.agentId===target.agentId&&existing.sessionId===target.sessionId;
    createdSessions.set(fromKey,{...target,revision});return true;
  }

  /** @param {ComposerScope} from */
  function createdSession(from){const value=createdSessions.get(scopeKey(from));return value?Object.freeze({agentId:value.agentId,sessionId:value.sessionId,revision:value.revision}):null}

  /** @param {{token?:unknown,scope?:unknown}} receipt @param {ComposerScope} from @param {ComposerScope} to */
  function promoteSubmission(receipt,from,to){
    const source=normalizedScope(from),target=normalizedScope(to),fromKey=scopeKey(source),toKey=scopeKey(target),submission=submissions.get(fromKey);
    if(!fromKey||!toKey||source.sessionId||!target.sessionId||source.agentId!==target.agentId||receipt?.scope!==fromKey||!submission||submission.token!==receipt.token)return false;
    const created=createdSessions.get(fromKey);if(!created||created.agentId!==target.agentId||created.sessionId!==target.sessionId)return false;
    if(pendingByScope.has(toKey)||submissions.has(toKey)||draftsByScope.has(toKey))return false;
    const sourceOutputKey=outputIntentKey(source),targetOutputKey=outputIntentKey(target),targetDraftKey=draftKey(target);
    const sourceOutput=readRaw(sourceOutputKey),targetOutput=readRaw(targetOutputKey),targetDraft=readRaw(targetDraftKey);
    if(!sourceOutput.ok||!targetOutput.ok||!targetDraft.ok)return false;
    if(!created.storage){
      if(targetOutput.value!==null||targetDraft.value!==null)return false;
      created.storage={sourceOutput:sourceOutput.value,targetDraft:targetDraft.value,targetOutput:targetOutput.value,draftCopies:[],outputCopies:[]};
    }
    const original=created.storage,targetDraftValue=submission.submittedDraft||null,desiredOutput=readOutputIntent(source)?"1":null;
    if(![null,"1"].includes(sourceOutput.value)||![original.targetOutput,...original.outputCopies].includes(targetOutput.value)||![original.targetDraft,...original.draftCopies].includes(targetDraft.value))return false;
    if(!original.draftCopies.includes(targetDraftValue))original.draftCopies.push(targetDraftValue);
    if(!original.outputCopies.includes(desiredOutput))original.outputCopies.push(desiredOutput);
    const promoted=(targetDraft.value===targetDraftValue||writeRaw(targetDraftKey,targetDraftValue))&&(targetOutput.value===desiredOutput||writeRaw(targetOutputKey,desiredOutput))&&(sourceOutput.value===null||writeRaw(sourceOutputKey,null));
    if(!promoted){
      writeRaw(targetDraftKey,original.targetDraft);writeRaw(targetOutputKey,original.targetOutput);writeRaw(sourceOutputKey,original.sourceOutput);
      return false;
    }
    const values=pendingByScope.get(fromKey),targetDraftState={value:submission.submittedDraft,version:submission.draftVersion};
    if(values?.length){pendingByScope.delete(fromKey);pendingByScope.set(toKey,values)}
    draftsByScope.delete(fromKey);draftsByScope.set(toKey,targetDraftState);
    const output=outputsByScope.get(fromKey);outputsByScope.delete(fromKey);outputsByScope.set(toKey,output??desiredOutput==="1");
    submissions.delete(fromKey);submissions.set(toKey,submission);
    createdSessions.delete(fromKey);
    return Object.freeze({token:receipt.token,scope:toKey});
  }

  /**
   * @param {{token?:unknown,scope?:unknown}} receipt
   * @param {string} recordId
   * @param {(file:File)=>Promise<Omit<UploadedAttachment,"recordId">|null|undefined>} upload
   */
  async function uploadSubmission(receipt,recordId,upload){
    const key=String(receipt?.scope||""),submission=submissions.get(key);if(!submission||submission.token!==receipt?.token)throw composerError("SUBMISSION_NOT_ACTIVE");const ids=submission.localIds;
    const values=pendingByScope.get(key)||[],byId=new Map(values.map(item=>[item.localId,item])),uploaded=[];
    for(const localId of ids){
      const item=byId.get(localId);if(!item)throw composerError("SUBMISSION_ATTACHMENT_MISSING");
      if(item.uploaded?.recordId===recordId){uploaded.push(Object.freeze({...item.uploaded}));continue}
      const value=await upload(item.file),id=String(value?.attachmentId||value?.id||"");if(!id)throw composerError("ATTACHMENT_INVALID_RESPONSE");item.uploaded={...value,recordId};uploaded.push(Object.freeze({...item.uploaded}));
    }
    return Object.freeze(uploaded);
  }

  /** @param {ComposerScope} scope @param {boolean} enabled */
  function acceptOutputIntent(scope,enabled){if(enabled)saveOutputIntent(scope,false)}

  /** Forget terminal bookkeeping without changing any composer-owned state. @param {unknown} runId */
  function discardCompletionOwnership(runId){return acceptedSubmissions.delete(String(runId||""))}

  /** @param {UploadedAttachment|undefined} uploaded */
  function uploadedId(uploaded){return String(uploaded?.attachmentId||uploaded?.id||"")}

  /**
   * Clear only state still owned by the completed submission. A newer draft
   * owns the entire composer, so neither it nor its pending files are touched.
   * @param {ComposerScope} scope
   * @param {{runId?:unknown,submittedDraft?:unknown,submittedAttachmentIds?:unknown}} submission
   * @param {unknown} currentDraft
   */
  function complete(scope,submission,currentDraft){
    const runId=String(submission?.runId||""),accepted=acceptedSubmissions.get(runId),key=scopeKey(scope),draft=draftsByScope.get(key),ids=Array.isArray(submission?.submittedAttachmentIds)?submission.submittedAttachmentIds.map(String):[];
    if(runId)acceptedSubmissions.delete(runId);
    if(!accepted||accepted.scope!==key||typeof currentDraft!=="string"||typeof submission?.submittedDraft!=="string"||submission.submittedDraft!==accepted.submittedDraft||currentDraft!==accepted.submittedDraft||draft?.value!==currentDraft||draft.version!==accepted.draftVersion||ids.length!==accepted.attachmentIds.length||ids.some((id,index)=>id!==accepted.attachmentIds[index]))return Object.freeze({owned:false,released:0});
    saveDraft(scope,"");
    const ownedLocalIds=new Set(accepted.localIds),values=key?pendingByScope.get(key):undefined;
    if(!values?.length||!ownedLocalIds.size)return Object.freeze({owned:true,released:0});
    let released=0;
    for(let index=values.length-1;index>=0;index--){const item=values[index];if(!item||!ownedLocalIds.has(item.localId))continue;values.splice(index,1);release(item);released++}
    if(!values.length)pendingByScope.delete(key);
    return Object.freeze({owned:true,released});
  }

  function isPreviewImageMime(value){return PREVIEW_IMAGE_MIMES.has(String(value).toLowerCase())}

  return Object.freeze({scopeKey,readDraft,saveDraft,currentDraft,readOutputIntent,saveOutputIntent,pending,addPending,removePending,startSubmission,isSubmitting,finishSubmission,commitSubmission,rememberCreatedSession,createdSession,promoteSubmission,uploadSubmission,acceptOutputIntent,discardCompletionOwnership,complete,isPreviewImageMime});
}
