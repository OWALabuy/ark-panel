import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type Input = {
  runStatus?: string | null; uploading: boolean; compacting: boolean;
  sessionId?: string | null; agentId?: string | null; archived: boolean;
  source?: string | null; trimmedInput: string; pendingCount: number;
  slashCommand: boolean; coarsePointer: boolean;
};
type State = Readonly<{
  writable: boolean; busy: boolean; stopping: boolean;
  textareaDisabled: boolean; attachDisabled: boolean; requestOutputsDisabled: boolean;
  pendingAttachmentActionsDisabled: boolean; sendDisabled: boolean;
  compactDisabled: boolean; messageActionsDisabled: boolean;
  placeholderKey: string; hintKey: string;
}>;

async function derive(input: Partial<Input>): Promise<State> {
  const url=pathToFileURL(join(process.cwd(),"src/frontend/composer-policy.js")).href;
  const module=await import(`${url}?composer-policy`) as {deriveComposerUiState(value:Input):State};
  return module.deriveComposerUiState({runStatus:null,uploading:false,compacting:false,sessionId:null,agentId:"fixture-agent",archived:false,source:null,trimmedInput:"",pendingCount:0,slashCommand:false,coarsePointer:false,...input});
}

test("new, panel, and read-only scopes preserve writable placeholders and pointer hints",async()=>{
  const fresh=await derive({});
  assert.equal(fresh.writable,true);assert.equal(fresh.sendDisabled,true);
  assert.equal(fresh.placeholderKey,"composer.newPlaceholder");assert.equal(fresh.hintKey,"composer.newHint");
  assert.equal((await derive({coarsePointer:true})).hintKey,"composer.mobileNewHint");

  const panel=await derive({sessionId:"panel-session",source:"panel",trimmedInput:"message"});
  assert.equal(panel.writable,true);assert.equal(panel.sendDisabled,false);
  assert.equal(panel.placeholderKey,"composer.placeholder");assert.equal(panel.hintKey,"composer.commandHint");
  assert.equal((await derive({sessionId:"panel-session",source:"panel",coarsePointer:true})).hintKey,"composer.mobileHint");
  assert.equal((await derive({sessionId:"panel-session",source:"panel",archived:true,trimmedInput:"message"})).writable,true);

  for(const readonly of [
    await derive({sessionId:"imported",source:"openclaw",trimmedInput:"ignored"}),
    await derive({agentId:null,trimmedInput:"ignored"}),
    await derive({archived:true,trimmedInput:"ignored"})
  ]){
    assert.equal(readonly.writable,false);assert.equal(readonly.textareaDisabled,true);assert.equal(readonly.attachDisabled,true);
    assert.equal(readonly.requestOutputsDisabled,true);assert.equal(readonly.sendDisabled,true);
    assert.equal(readonly.placeholderKey,"composer.readonlyPlaceholder");assert.equal(readonly.hintKey,"composer.readonlyHint");
  }
});

test("run phases preserve stop semantics and disable every competing action",async()=>{
  const running=await derive({sessionId:"session",source:"panel",runStatus:"running",trimmedInput:"message"});
  assert.equal(running.busy,true);assert.equal(running.stopping,false);assert.equal(running.sendDisabled,false);
  assert.equal(running.hintKey,"composer.runningHint");
  for(const key of ["textareaDisabled","attachDisabled","requestOutputsDisabled","pendingAttachmentActionsDisabled","compactDisabled","messageActionsDisabled"] as const)assert.equal(running[key],true,key);

  const aborting=await derive({sessionId:"session",source:"panel",runStatus:"aborting"});
  assert.equal(aborting.busy,true);assert.equal(aborting.stopping,true);assert.equal(aborting.sendDisabled,true);
  assert.equal(aborting.hintKey,"composer.stopWaiting");
});

test("upload and compaction precedence keep all composer actions busy",async()=>{
  const uploading=await derive({sessionId:"session",source:"panel",uploading:true,trimmedInput:"message"});
  assert.equal(uploading.busy,true);assert.equal(uploading.sendDisabled,true);assert.equal(uploading.hintKey,"composer.uploading");
  const compacting=await derive({sessionId:"session",source:"panel",uploading:true,compacting:true,trimmedInput:"message"});
  assert.equal(compacting.busy,true);assert.equal(compacting.sendDisabled,true);assert.equal(compacting.hintKey,"compact.running");
  for(const state of [uploading,compacting])for(const key of ["textareaDisabled","attachDisabled","requestOutputsDisabled","pendingAttachmentActionsDisabled","compactDisabled","messageActionsDisabled"] as const)assert.equal(state[key],true,key);
  for(const [input,hintKey] of [
    [{runStatus:"running",uploading:true},"composer.uploading"],
    [{runStatus:"aborting",uploading:true},"composer.uploading"],
    [{runStatus:"aborting",uploading:true,compacting:true},"compact.running"]
  ] as const)assert.equal((await derive({sessionId:"session",source:"panel",...input})).hintKey,hintKey);
});

test("text, attachments, and slash commands preserve send and output-intent policy",async()=>{
  const empty=await derive({sessionId:"session",source:"panel"}),text=await derive({sessionId:"session",source:"panel",trimmedInput:"hello"}),attachment=await derive({sessionId:"session",source:"panel",pendingCount:1}),command=await derive({sessionId:"session",source:"panel",trimmedInput:"/compact",slashCommand:true});
  assert.equal(empty.sendDisabled,true);assert.equal(text.sendDisabled,false);assert.equal(attachment.sendDisabled,false);assert.equal(command.sendDisabled,false);
  assert.equal(empty.requestOutputsDisabled,false);assert.equal(text.requestOutputsDisabled,false);assert.equal(attachment.requestOutputsDisabled,false);assert.equal(command.requestOutputsDisabled,true);
  assert.equal(empty.pendingAttachmentActionsDisabled,false);assert.equal(empty.compactDisabled,false);assert.equal(empty.messageActionsDisabled,false);
});
