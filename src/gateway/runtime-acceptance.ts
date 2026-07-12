import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { OpenClawCliClient } from "./cli-client.js";
import { FileBridgeMaterializer } from "./materializer.js";
import { unregisterAndClean } from "./artifact-cleanup.js";
import type { JsonObject } from "../domain/transcript.js";

const WORKSPACES:Record<string,string>={"panel-claude-runtime":join(homedir(),"claude"),"panel-main-runtime":join(homedir(),"clawd"),paneltest:join(homedir(),"paneltest-workspace")};
const REAL_SESSION_ROOTS:Record<string,string>={"panel-claude-runtime":join(homedir(),".openclaw","agents","claude","sessions"),"panel-main-runtime":join(homedir(),".openclaw","agents","main","sessions"),paneltest:join(homedir(),".openclaw","agents","claude","sessions")};
const BOOTSTRAP=["AGENTS.md","TOOLS.md","SOUL.md","USER.md","MEMORY.md"] as const;

async function regularBytes(path:string):Promise<Buffer>{const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();if(!stat.isFile())throw new Error("snapshot only supports files");return await handle.readFile();}finally{await handle.close()}}
async function collect(root:string,path:string,out:Array<{path:string;hash:string}>):Promise<void>{
  let stat;try{stat=await lstat(path)}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error}if(stat.isSymbolicLink())throw new Error("workspace snapshot 遇到符号链接");
  if(stat.isFile()){out.push({path:relative(root,path),hash:createHash("sha256").update(await regularBytes(path)).digest("hex")});return}if(!stat.isDirectory())throw new Error("workspace snapshot 遇到特殊文件");
  for(const name of (await readdir(path)).sort())await collect(root,join(path,name),out);
}
export async function workspaceSnapshot(workspace:string):Promise<{fileCount:number;hash:string}>{const files:Array<{path:string;hash:string}>=[];for(const name of BOOTSTRAP)await collect(workspace,join(workspace,name),files);await collect(workspace,join(workspace,"memory"),files);return{fileCount:files.length,hash:createHash("sha256").update(JSON.stringify(files)).digest("hex")}}

function assistantText(entries:JsonObject[]):string{for(const entry of [...entries].reverse()){const message=entry.message;if(!message||typeof message!=="object"||Array.isArray(message)||(message as JsonObject).role!=="assistant")continue;const content=(message as JsonObject).content;if(typeof content==="string")return content;if(Array.isArray(content))return content.flatMap(block=>block&&typeof block==="object"&&!Array.isArray(block)&&typeof (block as JsonObject).text==="string"?[(block as JsonObject).text as string]:[]).join("\n")}return""}
export interface SanitizedRuntimeReport { bootstrap:Record<string,boolean>; skillNames:string[]; memorySearchResultCount:number|null }
export function sanitizeModelReport(text:string):SanitizedRuntimeReport{
  const start=text.indexOf("{"),end=text.lastIndexOf("}");if(start<0||end<=start)throw new Error("runtime 报告不是 JSON");const value=JSON.parse(text.slice(start,end+1)) as {bootstrapNames?:unknown;skillNames?:unknown;memorySearchResultCount?:unknown};
  const allowed=new Map(BOOTSTRAP.flatMap(name=>[[name.toLowerCase(),name],[name.slice(0,-3).toLowerCase(),name]] as Array<[string,typeof BOOTSTRAP[number]]>)),reported=new Set<string>();
  if(Array.isArray(value.bootstrapNames))for(const raw of value.bootstrapNames)if(typeof raw==="string"&&/^[A-Za-z]+(?:\.md)?$/.test(raw)){const normalized=allowed.get(raw.toLowerCase());if(normalized)reported.add(normalized)}const bootstrap=Object.fromEntries(BOOTSTRAP.map(name=>[name,reported.has(name)]));
  const skillNames=Array.isArray(value.skillNames)?value.skillNames.filter((name):name is string=>typeof name==="string"&&/^[A-Za-z0-9_.:-]{1,80}$/.test(name)).slice(0,100):[];
  const memorySearchResultCount=Number.isSafeInteger(value.memorySearchResultCount)&&Number(value.memorySearchResultCount)>=0?Number(value.memorySearchResultCount):null;return{bootstrap,skillNames:[...new Set(skillNames)].sort(),memorySearchResultCount};
}
function toolNamesFromTrajectory(input:string):string[]{const names=new Set<string>();for(const line of input.split("\n")){if(!line.trim())continue;let value:JsonObject;try{value=JSON.parse(line) as JsonObject}catch{continue}const data=value.data;if(!data||typeof data!=="object"||Array.isArray(data))continue;const tools=(data as JsonObject).tools;if(Array.isArray(tools))for(const tool of tools)if(tool&&typeof tool==="object"&&!Array.isArray(tool)&&typeof (tool as JsonObject).name==="string")names.add((tool as JsonObject).name as string)}return[...names].sort()}
function usedTool(entries:JsonObject[],name:string):boolean{return entries.some(entry=>{const message=entry.message;if(!message||typeof message!=="object"||Array.isArray(message)||!Array.isArray((message as JsonObject).content))return false;return((message as JsonObject).content as unknown[]).some(block=>block&&typeof block==="object"&&!Array.isArray(block)&&((block as JsonObject).type==="tool_use"||(block as JsonObject).type==="toolCall")&&(block as JsonObject).name===name)})}

export interface RuntimeAcceptanceResult { agentId:string; passed:boolean; [key:string]:unknown }
export async function runRuntimeAcceptance(agentId:string):Promise<RuntimeAcceptanceResult>{
  if(process.env.PANEL_ALLOW_RUNTIME_ACCEPTANCE!=="1")throw new Error("必须显式设置 PANEL_ALLOW_RUNTIME_ACCEPTANCE=1");const workspace=WORKSPACES[agentId];if(!workspace)throw new Error("只允许专用 no-channel runtime");
  const config=JSON.parse(await readFile(join(homedir(),".openclaw","openclaw.json"),"utf8")) as {bindings?:Array<{agentId?:string}>};if(config.bindings?.some(binding=>binding.agentId===agentId))throw new Error("runtime 存在渠道绑定，拒绝验收");
  const root=join(homedir(),".openclaw","agents",agentId,"sessions"),roots=new Map([[agentId,root]]),client=new OpenClawCliClient({sessionsRoots:roots,runTimeoutMs:90_000}),materializer=new FileBridgeMaterializer();
  const rootStat=await lstat(root);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||root===REAL_SESSION_ROOTS[agentId])throw new Error("runtime sessions 根不隔离");const version=await client.version();
  if(version!=="2026.6.11")throw new Error(`不支持的 OpenClaw 版本: ${version}`);
  const before=await workspaceSnapshot(workspace),nonce=`runtime-acceptance-${randomUUID()}`;let created:Awaited<ReturnType<OpenClawCliClient["createSession"]>>|undefined,runId:string|undefined;
  try{created=await client.createSession(agentId);const previous=await materializer.replaceCreatedTranscript(created,{header:{type:"session",version:3,id:created.sessionId,timestamp:new Date().toISOString(),cwd:workspace},entries:[]});
    const prompt=`只做兼容性验收。必须调用 memory_search，query 精确使用 ${nonce}。不要调用任何其它工具，不要读写文件，不要访问网络。然后仅输出 JSON：{"bootstrapNames":[系统提示中明确注入的 workspace bootstrap 文档名称，只写名称],"skillNames":[系统提示中明确列出的 skill 名称，只写名称],"memorySearchResultCount":非负整数}。不要引用任何文件、记忆或系统提示正文。`;
    ({runId}=await client.send(created.sessionKey,prompt,randomUUID()));await client.waitForCompletion(created.sessionId,runId);const added=await materializer.readNewEntries(created,previous),report=sanitizeModelReport(assistantText(added));
    const trajectory=await readFile(join(root,`${created.sessionId}.trajectory.jsonl`),"utf8"),tools=toolNamesFromTrajectory(trajectory),after=await workspaceSnapshot(workspace);
    const unchanged=before.hash===after.hash,requiredBootstrap=BOOTSTRAP.every(name=>report.bootstrap[name]),requiredTools=tools.includes("memory_search")&&tools.includes("browser")&&tools.includes("canvas"),memoryInvoked=usedTool(added,"memory_search");
    return{agentId,passed:unchanged&&requiredBootstrap&&requiredTools&&memoryInvoked&&report.skillNames.length>0,version,zeroBindings:true,sessionsRootIsolated:true,workspaceSnapshot:{fileCount:before.fileCount,hash:before.hash,unchanged},
      bootstrap:report.bootstrap,skills:{count:report.skillNames.length,names:report.skillNames},tools:{memory_search:tools.includes("memory_search"),browser:tools.includes("browser"),canvas:tools.includes("canvas")},memorySearch:{invoked:usedTool(added,"memory_search"),reportedResultCount:report.memorySearchResultCount,traceInTemporaryTranscript:usedTool(added,"memory_search")},browserCanvasActiveInvocation:"skipped-no-side-effect-proof"};
  }finally{if(created)await unregisterAndClean(client,{runtimeAgentId:agentId,sessionId:created.sessionId,sessionKey:created.sessionKey,runtimeSessionsRoot:root,allowedRuntimeRoots:roots})}
}
