/**
 * Derive composer presentation policy without reading browser or application
 * state. Callers supply the already-normalized input and apply the returned
 * localization keys and disabled flags to the DOM.
 * @param {{
 *   runStatus:string|null|undefined,
 *   uploading:boolean,
 *   compacting:boolean,
 *   sessionId:string|null|undefined,
 *   agentId:string|null|undefined,
 *   archived:boolean,
 *   source:string|null|undefined,
 *   trimmedInput:string,
 *   pendingCount:number,
 *   slashCommand:boolean,
 *   coarsePointer:boolean
 * }} input
 */
export function deriveComposerUiState(input){
  const running=Boolean(input.runStatus),stopping=input.runStatus==="aborting",uploading=Boolean(input.uploading),compacting=Boolean(input.compacting),busy=running||uploading||compacting;
  const noSession=!input.sessionId&&Boolean(input.agentId)&&!input.archived,writable=noSession||(Boolean(input.sessionId)&&input.source==="panel"),hasInput=Boolean(input.trimmedInput||input.pendingCount);
  return Object.freeze({
    writable,busy,stopping,
    textareaDisabled:busy||!writable,
    attachDisabled:busy||!writable,
    requestOutputsDisabled:busy||!writable||input.slashCommand,
    pendingAttachmentActionsDisabled:busy,
    sendDisabled:running?stopping:(busy||!writable||!hasInput),
    compactDisabled:busy,
    messageActionsDisabled:busy,
    placeholderKey:noSession?"composer.newPlaceholder":writable?"composer.placeholder":"composer.readonlyPlaceholder",
    hintKey:compacting?"compact.running":uploading?"composer.uploading":stopping?"composer.stopWaiting":running?"composer.runningHint":noSession?(input.coarsePointer?"composer.mobileNewHint":"composer.newHint"):writable?(input.coarsePointer?"composer.mobileHint":"composer.commandHint"):"composer.readonlyHint"
  });
}
