import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("frontend renders untrusted metadata with DOM text nodes", async () => {
  const source=await readFile("src/frontend/app.js","utf8"),markdown=await readFile("src/frontend/markdown.js","utf8"),i18n=await readFile("src/frontend/i18n/index.js","utf8"),zh=await readFile("src/frontend/i18n/zh-CN.js","utf8");
  assert.doesNotMatch(source,/\.innerHTML\s*=/);
  assert.doesNotMatch(markdown,/\.innerHTML\s*=/);
  assert.match(source,/textContent=/);
  assert.match(source,/renderMarkdown\(text\)/);
  assert.match(source,/t\("message\.copy"\)/);
  assert.match(zh,/"message\.copy":"复制消息"/);
  assert.match(source,/command:"commands",args:\[\]/);
  assert.match(source,/result\?\.data\?\.commands/);
  assert.match(i18n,/Intl\.DateTimeFormat/);
  assert.match(source,/className="message-body"/);
  assert.match(source,/className="message-meta"/);
  const styles=await readFile("src/frontend/styles.css","utf8");
  assert.match(styles,/\.composer textarea:placeholder-shown\{height:auto!important\}/);
  assert.match(source,/method:"PATCH"/);
  assert.match(source,/archived=\$\{viewingArchived\}/);
  assert.match(source,/t\("editor\.renameTitle"\)/);
  assert.match(source,/method:"DELETE"/);
  assert.match(source,/JSON\.stringify\(\{confirm:true\}\)/);
  assert.match(source,/function openProjectMenu\(trigger,record\)/);
  assert.match(source,/\/projects\?agentId=/);
  assert.match(source,/function assignProject\(recordId,project\)/);
  assert.match(source,/JSON\.stringify\(\{project\}\)/);
  assert.doesNotMatch(source,/title:"会话分组"/);
  assert.match(source,/\/export\.md/);
  assert.match(source,/ark-panel:collapsed-projects:/);
  assert.match(source,/project\?`project:\$\{project\}`:"ungrouped"/);
  assert.doesNotMatch(source,/project\|\|"__ungrouped__"/);
  assert.match(source,/aria-expanded/);
  assert.match(source,/t\("project\.ungrouped"\)/);
  assert.match(source,/function nearMessagesBottom/);
  assert.match(source,/t\("message\.newAvailable"\)/);
  assert.match(source,/className="session-quick-actions"/);
  assert.match(source,/event\.stopPropagation\(\)/);
  assert.match(source,/updateSessionFromList\(id,\{pinned:!session\.pinned\}\)/);
  assert.match(source,/updateSessionFromList\(id,\{archived:!viewingArchived\}\)/);
  assert.match(source,/exportSession\(id\)/);
  assert.match(source,/quickSessionAction\(t\("project\.move"\)/);
  assert.match(source,/move\.dataset\.projectRecord=id/);
  assert.match(source,/aria-haspopup/);
  assert.match(source,/setAttribute\("role","menuitemradio"\)/);
  assert.match(source,/project\.toLocaleLowerCase\(\)===value\.toLocaleLowerCase\(\)/);
  assert.match(source,/event\.key==="Escape"&&projectMenuCreating/);
  assert.match(source,/\["ArrowDown","ArrowUp","Home","End"\]/);
  assert.match(source,/closeProjectMenu\(\)/);
  assert.match(styles,/\.project-menu\{position:fixed/);
  assert.match(styles,/@media\(max-width:760px\),\(hover:none\)\{\.session-quick-actions\{opacity:1;visibility:visible\}/);
  assert.match(markdown,/SAFE_PROTOCOLS=new Set\(\["http:","https:","mailto:"\]\)/);
  assert.match(markdown,/createTextNode/);
  assert.match(markdown,/t\("error\.copyCode"\)/);
  assert.match(markdown,/LANGUAGE_ALIASES/);
  assert.match(markdown,/className=`syntax-\$\{type\}`/);
  assert.match(markdown,/className="code-language"/);
  assert.match(markdown,/else code\.textContent=text/);
  assert.match(markdown,/noopener noreferrer/);
  assert.match(markdown,/globalThis\.katex\.render/);
  assert.match(markdown,/trust:false/);
  assert.match(markdown,/function mathBlock/);
  assert.match(styles,/\.math-display/);
  assert.doesNotMatch(markdown,/insertAdjacentHTML|document\.write|eval\(/);
  assert.match(source,/text\/event-stream/);
  assert.match(source,/\/search\?q=/);
  assert.match(source,/\/fork/);
  assert.match(source,/\/resend/);
  assert.match(source,/activeRevision/);
  assert.doesNotMatch(source,/\bprompt\s*\(/);
  assert.match(source,/showModal\(\)/);
  assert.match(source,/addEventListener\("cancel"/);
  assert.match(source,/trimStart\(\)\.startsWith\("\/"\)/);
  assert.match(source,/\/auth\/logout/);
  assert.match(source,/\/revisions\?agentId=/);
  assert.match(source,/block\.input\?\?block\.arguments/);
  assert.match(source,/block\.text\?\?block\.thinking/);
  assert.match(source,/function activeBranch\(entries\)/);
  assert.match(source,/role!=="toolResult"/);
  assert.match(source,/calls\.get\(result\.callId\)/);
  assert.match(source,/call\.result=result/);
  assert.match(source,/block\.result\.isError/);
  assert.match(source,/\/sessions\/\$\{encodeURIComponent\(sourceSession\)\}\/runs/);
  assert.match(source,/\/runs\/\$\{encodeURIComponent\(run\.runId\)\}\/abort/);
  assert.match(source,/\/runs\/\$\{encodeURIComponent\(run\.runId\)\}\/events/);
  assert.match(source,/\/sessions\/\$\{encodeURIComponent\(recordId\)\}\/runs\/active/);
  assert.match(source,/streamDropped/);
  assert.match(source,/function renderStreamPreview\(run\)/);
  assert.match(source,/className="message assistant streaming stream-preview"/);
  assert.match(source,/terminalRun\(run\.status\)\|\|!stream/);
  assert.match(source,/Object\.prototype\.hasOwnProperty\.call\(raw,"stream"\)\?raw\.stream:undefined/);
  assert.match(styles,/\.message\.streaming/);
  assert.match(source,/if\(!terminal\)throw Object\.assign/);
  assert.match(source,/RUN_PREFIX="ark-panel:run:v1:"/);
  assert.match(source,/runsBySession=new Map\(\)/);
  assert.match(source,/function recoverStoredRuns/);
  assert.match(source,/function reconcileCreatedRun/);
  assert.match(source,/"idempotency-key":run\.runId/);
  assert.match(source,/submittedDraft:message/);
  assert.match(source,/readDraft\(run\.recordId,agentId\)===run\.submittedDraft/);
  assert.match(source,/if\(ownsDraft\)saveDraft/);
  assert.match(source,/t\("error\.stopUnknown"\)/);
  assert.match(source,/DRAFT_PREFIX="ark-panel:draft:v1:"/);
  assert.match(source,/localStorage\.setItem/);
  assert.match(source,/localStorage\.removeItem/);
  assert.match(source,/restoreDraft\(id\)/);
  assert.match(source,/if\(ownsDraft\)saveDraft\("",run\.recordId,agentId\)/);
  assert.match(source,/sourceSession=activeSession,sourceRevision=activeRevision/);
  assert.doesNotMatch(source,/\/compact|\/reset/);
});

test("generation state only locks the composer for its own session", async () => {
  const source=await readFile("src/frontend/app.js","utf8");

  assert.match(source,/runsBySession=new Map\(\)/);
  assert.match(source,/function syncActiveRun\(\)\{activeRun=runsBySession\.get\(activeSession\)\|\|null\}/);
  assert.match(source,/activeSession=id;[\s\S]*?syncActiveRun\(\);[\s\S]*?restoreDraft\(id\);updateComposer\(\)/);
  assert.match(source,/const textarea=\$\("#message"\),running=Boolean\(activeRun\)/);
  assert.match(source,/textarea\.disabled=busy\|\|!writable/);
  assert.match(source,/if\(activeSession!==run\.recordId\)return;syncActiveRun\(\)/);
});

test("appearance preferences are constrained, cached early, and locally scale reading content", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  const html=await readFile("src/frontend/index.html","utf8");
  const bootstrap=await readFile("src/frontend/theme-bootstrap.js","utf8");
  const styles=await readFile("src/frontend/styles.css","utf8");

  assert.match(html,/src="\/theme-bootstrap\.js"/);
  assert.match(bootstrap,/ark-panel:appearance:v1/);
  assert.match(bootstrap,/document\.documentElement\.dataset\.theme/);
  assert.match(html,/id="settings-drawer"[\s\S]*aria-modal="true"/);
  assert.match(html,/id="reading-scale"[^>]*min="85"[^>]*max="130"[^>]*step="5"/);
  assert.match(source,/THEMES=new Set\(\["system","light","dark","gruvbox-dark-hard","gruvbox-dark-medium","gruvbox-dark-soft","gruvbox-light-hard","gruvbox-light-medium","gruvbox-light-soft"\]\)/);
  assert.match(source,/ACCENTS=new Set\(\["default","blue","green","red","yellow","magenta","cyan"\]\)/);
  assert.match(source,/api\("\/settings",\{method:"PATCH"/);
  assert.match(source,/READING_SCALE_KEY="ark-panel:reading-scale:v1"/);
  assert.match(source,/number>=85&&number<=130&&number%5===0/);
  assert.match(source,/confirmedAppearance=accountAppearance,desiredAppearance=accountAppearance/);
  assert.match(source,/desiredAppearance=normalizeAppearance\(\{\.\.\.desiredAppearance,\.\.\.patch\}\)/);
  assert.match(source,/body:JSON\.stringify\(\{appearance:target\}\)/);
  assert.match(source,/if\(sameAppearance\(target,desiredAppearance\)\)\{desiredAppearance=confirmedAppearance;applyAppearance\(confirmedAppearance\)/);
  for(const theme of ["gruvbox-dark-hard","gruvbox-dark-medium","gruvbox-dark-soft","gruvbox-light-hard","gruvbox-light-medium","gruvbox-light-soft"]){
    assert.match(styles,new RegExp(`\\[data-theme="${theme}"\\]`));
    assert.match(html,new RegExp(`value="${theme}"`));
  }
  assert.match(styles,/--code-background:/);
  assert.match(styles,/--syntax-keyword:/);
  assert.match(styles,/--danger-soft:/);
  assert.match(styles,/color-scheme:dark/);
  assert.match(styles,/font-size:var\(--reading-size\)/);
});

test("conversation status is server-controlled, separate from run status, and labels conservative context estimates", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  const statusHelper=await readFile("src/frontend/conversation-status.js","utf8");
  const html=await readFile("src/frontend/index.html","utf8");
  const styles=await readFile("src/frontend/styles.css","utf8");

  assert.match(html,/id="subtitle"[\s\S]*id="conversation-status"/);
  assert.match(html,/id="show-conversation-status"[^>]*type="checkbox"/);
  assert.match(source,/body:JSON\.stringify\(\{conversation:\{showStatus:target\}\}\)/);
  assert.match(source,/confirmedShowConversationStatus=settings\?\.conversation\?\.showStatus!==false/);
  assert.match(source,/applyConversationStatusSetting\(confirmedShowConversationStatus\)/);
  assert.match(source,/renderConversationStatus\(conversation\.status\)/);
  assert.match(source,/activeSource==="panel"\?"status\.defaultModel":"status\.sourceDefaultModel"/);
  assert.match(source,/t\("status\.contextTitle"/);
  assert.match(source,/contextStatusClass\(percentage\)/);
  assert.match(statusHelper,/value>=90\?"context-danger":value>=70\?"context-warning":""/);
  assert.match(statusHelper,/if\(seconds<60\)return text\("status\.justNow"\)/);
  assert.match(styles,/\.conversation-status\[hidden\]\{display:none\}/);
  assert.match(styles,/\.conversation-status-item\.context-warning/);
  assert.match(styles,/\.conversation-status-item\.context-danger/);
});

test("background run notifications stay unread per session until the conversation is viewed", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  const styles=await readFile("src/frontend/styles.css","utf8");

  assert.match(source,/UNREAD_KEY="ark-panel:unread-runs:v1"/);
  assert.match(source,/let unreadRuns=readUnreadRuns\(\)/);
  assert.match(source,/new Map\(entries\.flatMap/);
  assert.match(source,/status==="completed"\|\|status==="failed"/);
  assert.match(source,/activeSession===run\.recordId&&!document\.hidden/);
  assert.match(source,/unreadRuns\.set\(String\(run\.recordId\),\{agentId:String\(run\.agentId\|\|activeAgent\),status:run\.status\}\)/);
  assert.match(source,/if\(!document\.hidden\)clearUnreadRun\(id\)/);
  assert.match(source,/document\.addEventListener\("visibilitychange",updateDocumentTitle\)/);
  assert.doesNotMatch(source,/visibilitychange[^\n]*clearUnreadRun/);
  assert.match(source,/count=document\.hidden\?unreadRuns\.size:0/);
  assert.match(source,/unread-marker/);
  assert.match(source,/unread\.some\(item=>item\.status==="failed"\)/);
  assert.match(source,/if\(run\.status!=="completed"&&run\.status!=="failed"\)return/);
  assert.match(styles,/\.unread-marker\.failed/);
});

test("edit and resend opens a fork and submits the replacement through the normal composer run", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  assert.match(source,/async function editAndResend[\s\S]*\/resend[\s\S]*openSession\(String\(created\.recordId\)\)[\s\S]*saveDraft\(replacement\)[\s\S]*requestSubmit\(\)/);
});

test("desktop navigation can collapse to an accessible persistent rail", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  const html=await readFile("src/frontend/index.html","utf8");
  const styles=await readFile("src/frontend/styles.css","utf8");

  assert.match(html,/id="sidebar-rail"[\s\S]*id="expand-sidebar"[\s\S]*id="rail-recents"[^>]*aria-haspopup="menu"/);
  assert.match(html,/id="rail-agent"[^>]*aria-haspopup="menu"/);
  assert.match(source,/SIDEBAR_KEY="ark-panel:sidebar-collapsed:v1"/);
  assert.match(source,/localStorage\.setItem\(SIDEBAR_KEY,String\(Boolean\(collapsed\)\)\)/);
  assert.match(source,/slice\(0,10\)/);
  assert.match(source,/function closeRailFlyout\(\{restore=true\}=\{\}\)/);
  assert.match(source,/event\.key==="Escape"&&!\$\("#rail-flyout"\)\.hidden/);
  assert.match(source,/function refreshUnreadUi\(\)\{renderAgents\(\);renderRail\(\)/);
  assert.match(source,/showAgentFlyout[\s\S]*unreadRuns\.values\(\)/);
  assert.match(source,/function clearConversationSelection\(\)[\s\S]*\$\("#title"\)\.textContent=t\("session\.select"\)/);
  assert.match(source,/async function switchAgent\(agentId\)[\s\S]*clearConversationSelection\(\)/);
  assert.match(styles,/\.shell\.sidebar-collapsed\{grid-template-columns:60px minmax\(0,1fr\)\}/);
  assert.match(styles,/@media\(max-width:760px\)\{\.sidebar-rail/);
});

test("agent avatars are cropped client-side and uploaded with CSRF protection", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  const html=await readFile("src/frontend/index.html","utf8");
  const server=await readFile("src/server/app.ts","utf8");

  assert.match(html,/id="avatar-file"[^>]*accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html,/id="reset-avatar"/);
  assert.match(html,/id="confirm-avatar"[^>]*hidden/);
  assert.match(source,/MAX_AVATAR_BYTES=5\*1024\*1024/);
  assert.match(source,/createImageBitmap\(file\)/);
  assert.match(source,/Math\.min\(bitmap\.width,bitmap\.height\)/);
  assert.match(source,/canvas\.toBlob\(resolve,"image\/webp",\.88\)/);
  assert.match(source,/pendingAvatar=\{agentId,blob,url:URL\.createObjectURL\(blob\)\}/);
  assert.match(source,/status\.textContent=t\("avatar\.confirmPreview"\)/);
  assert.match(source,/fetch\(avatarUrl\(agentId\),\{method,body,headers:\{"x-csrf-token":csrf/);
  assert.match(source,/avatarRequest\(agentId,"PUT",blob\)/);
  assert.match(source,/avatarRequest\(agentId,"DELETE"\)/);
  assert.match(server,/img-src 'self' blob:/);
});

test("composer uploads raw attachments and preserves their ids for idempotent run recovery", async () => {
  const source=await readFile("src/frontend/app.js","utf8");
  const html=await readFile("src/frontend/index.html","utf8");
  const styles=await readFile("src/frontend/styles.css","utf8");

  assert.match(html,/id="attachment-input"[^>]*\.docx[^>]*\.xlsx[^>]*\.pptx[^>]*multiple/);
  assert.match(source,/body:item\.file/);
  assert.doesNotMatch(source,/FileReader|readAsText|arrayBuffer\(\).*docx|mammoth|officegen/);
  assert.match(source,/addEventListener\("paste"/);
  assert.match(source,/addEventListener\("drop"/);
  assert.match(source,/attachmentIds:run\.submittedAttachmentIds\|\|\[\]/);
  assert.match(source,/submittedAttachmentIds:run\.submittedAttachmentIds/);
  assert.match(source,/pendingAttachments\.delete\(`session:\$\{run\.recordId\}`\)/);
  assert.match(source,/if\(run\.status==="completed"\)/);
  assert.match(source,/\/api\/v1\/files\/\$\{encodeURIComponent\(block\.id\)\}\/download/);
  assert.match(source,/\/api\/v1\/files\/\$\{encodeURIComponent\(block\.id\)\}\/preview/);
  assert.match(source,/PREVIEW_IMAGE_MIMES=new Set\(\["image\/png","image\/jpeg","image\/webp"\]\)/);
  assert.match(source,/previewUrl:URL\.createObjectURL\(file\)/);
  assert.match(source,/URL\.revokeObjectURL\(item\.previewUrl\)/);
  assert.match(source,/image\.loading="lazy"/);
  assert.match(html,/id="image-preview-dialog"/);
  assert.match(styles,/\.attachment-card\.output/);
  assert.match(styles,/\.message-image-button/);
  assert.match(styles,/\.image-preview-dialog/);
  assert.match(styles,/\.composer\.dragging/);
});
