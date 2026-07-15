import { createPanelServer } from "../dist/src/server/app.js";
import { passwordHash } from "../dist/src/server/auth.js";

const port=Number(process.env.PANEL_BROWSER_PORT||"8899"),origin=`http://127.0.0.1:${port}`;
const conversations=new Map([["fixture-1",{recordId:"fixture-1",agentId:"fixture",sourceKind:"panel",title:"脱敏浏览器验收",revision:"1",updatedAt:new Date().toISOString(),messageCount:2,document:{header:{type:"session"},entries:[
  {type:"message",id:"u1",parentId:null,message:{role:"user",content:"请检查虚构项目。"}},
  {type:"message",id:"a1",parentId:"u1",stopReason:"stop",message:{role:"assistant",content:[{type:"thinking",text:"这是完全虚构的思考。"},{type:"tool_use",name:"fixture_read",input:{path:"/fixture/demo"}},{type:"tool_result",content:"虚构工具结果"},{type:"text",text:"浏览器验收内容已准备好。"}]}}
]}}],["fixture-active",{recordId:"fixture-active",agentId:"fixture",sourceKind:"active",title:"只读活会话示例",revision:"1",updatedAt:new Date().toISOString(),messageCount:1,document:{header:{type:"session"},entries:[{type:"message",id:"active-u1",message:{role:"user",content:"这是只读来源。"}}]}}]]);
let counter=1;
const failedOnce=new Set();
const reads={
  async agents(){return[{id:"fixture",label:"Fixture",sessionCount:conversations.size}]},
  async sessions(agentId){return agentId&&agentId!=="fixture"?[]:[...conversations.values()].map(({document,...record})=>record)},
  async conversation(recordId){return conversations.get(recordId)||null},
  async search(query){const needle=query.toLowerCase();return[...conversations.values()].filter(value=>JSON.stringify(value.document).toLowerCase().includes(needle)).map(({document,...record})=>({...record,hits:[{snippet:"虚构搜索命中：浏览器验收内容"}]}))},
  async createPanel(agentId,title){const id=`fixture-${++counter}`,now=new Date().toISOString(),value={recordId:id,agentId,sourceKind:"panel",title:title||"未命名会话",revision:"1",updatedAt:now,messageCount:0,document:{header:{type:"session"},entries:[]}};conversations.set(id,value);return value},
  async fork(recordId,messageId){const source=conversations.get(recordId),id=`fixture-${++counter}`,now=new Date().toISOString(),value={...structuredClone(source),recordId:id,title:`${source.title} · fork`,revision:"1",updatedAt:now};value.document.entries=value.document.entries.slice(0,value.document.entries.findIndex(entry=>entry.id===messageId)+1);conversations.set(id,value);return{recordId:id,agentId:"fixture",sourceKind:"panel"}},
  async editAndFork(recordId,messageId,replacement){const created=await this.fork(recordId,messageId),value=conversations.get(created.recordId),target=value.document.entries.find(entry=>entry.id===messageId);target.message.content=replacement;value.title="编辑重发分支";return created}
};
const runs=new Map(),listeners=new Map();
function publicRun(run){const {message:_,...visible}=run;return{...visible,canAbort:["accepted","running","materializing"].includes(run.status)}}
function publish(run){run.sequence++;run.updatedAt=new Date().toISOString();for(const listener of listeners.get(run.runId)||[])listener(publicRun(run));if(["completed","failed","aborted"].includes(run.status))listeners.delete(run.runId)}
const generation={
  async create(recordId,message,runId=crypto.randomUUID()){
    const existing=runs.get(runId);if(existing){if(existing.recordId!==recordId||existing.message!==message)throw new Error("IDEMPOTENCY_KEY_REUSED");return{...publicRun(existing),newlyCreated:false}}
    if(!conversations.has(recordId))throw new Error("PANEL_SESSION_NOT_FOUND");if([...runs.values()].some(run=>run.recordId===recordId&&!["completed","failed","aborted"].includes(run.status)))throw new Error("SESSION_BUSY");
    const now=new Date().toISOString(),run={runId,recordId,message,status:"accepted",sequence:1,createdAt:now,updatedAt:now};runs.set(runId,run);
    setTimeout(()=>{if(run.status==="aborted")return;run.status="running";publish(run);setTimeout(()=>{
      if(run.status==="aborted")return;const retryKey=`${recordId}\0${message}`;
      if(message==="请重试"&&!failedOnce.has(retryKey)){failedOnce.add(retryKey);run.status="failed";run.error={code:"RUN_FAILED",message:"虚构的首次生成失败，请重试。"};publish(run);return}
      const value=conversations.get(recordId);value.document.entries.push({type:"message",id:`u-${Date.now()}`,message:{role:"user",content:message}},{type:"message",id:`a-${Date.now()}`,stopReason:"stop",message:{role:"assistant",content:[{type:"text",text:"虚构 SSE 回复"}]}});value.messageCount=value.document.entries.length;value.revision=String(Number(value.revision)+1);value.updatedAt=new Date().toISOString();run.status="completed";run.revision=value.revision;publish(run)
    },120)},0);return{...publicRun(run),newlyCreated:true}
  },
  async get(runId){const run=runs.get(runId);return run?publicRun(run):undefined},
  async subscribe(runId,listener){const run=runs.get(runId);if(!run)return undefined;listener(publicRun(run));if(["completed","failed","aborted"].includes(run.status))return()=>{};const set=listeners.get(runId)||new Set();set.add(listener);listeners.set(runId,set);return()=>{set.delete(listener);if(!set.size)listeners.delete(runId)}},
  async abortRun(runId){const run=runs.get(runId);if(!run)return undefined;if(!["completed","failed","aborted"].includes(run.status)){run.status="aborted";publish(run)}return publicRun(run)},
  async activeForRecord(recordId){const run=[...runs.values()].find(item=>item.recordId===recordId&&!["completed","failed","aborted"].includes(item.status));return run?publicRun(run):undefined}
};
const server=createPanelServer({auth:{username:"fixture",passwordHash:passwordHash("fixture-password","00112233445566778899aabbccddeeff"),sessionSecret:"fixture-session-secret-32-characters-long"},publicDir:new URL("../src/frontend",import.meta.url).pathname,reads,generation,allowedHosts:[`127.0.0.1:${port}`],publicOrigins:[origin]});
server.listen(port,"127.0.0.1",()=>process.stdout.write(`${origin}\n`));
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>server.close(()=>process.exit(0)));
