import {t} from "./i18n/index.js";
const SAFE_PROTOCOLS=new Set(["http:","https:","mailto:"]);
const LANGUAGE_ALIASES={javascript:"js",jsx:"js",typescript:"ts",tsx:"ts",shell:"bash",sh:"bash",zsh:"bash",py:"python",yml:"yaml",html:"markup",xml:"markup",svg:"markup",rs:"rust"};
const LANGUAGE_LABELS={js:"JavaScript",ts:"TypeScript",json:"JSON",bash:"Shell",python:"Python",rust:"Rust",css:"CSS",markup:"HTML",sql:"SQL",yaml:"YAML",diff:"Diff"};
const KEYWORDS={
  js:new Set("as async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield".split(" ")),
  ts:new Set("abstract any as asserts async await bigint boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of override private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield".split(" ")),
  python:new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  bash:new Set("case do done elif else esac fi for function if in select then time until while".split(" ")),
  rust:new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
  sql:new Set("add all alter and any as asc begin between by case check column commit create database default delete desc distinct drop else end exists foreign from full grant group having in index inner insert into is join key left like limit not null on or order outer primary references right rollback row select set table then union unique update values view when where with".toUpperCase().split(" "))
};
function languageName(raw){const normalized=String(raw||"").toLowerCase().replace(/^language-/,"");return LANGUAGE_ALIASES[normalized]||normalized}
function token(root,type,text){const node=document.createElement("span");node.className=`syntax-${type}`;node.textContent=text;root.append(node)}
function highlightGeneric(root,text,language){const keywords=KEYWORDS[language],pattern=language==="python"||language==="bash"?/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|([A-Za-z_$][\w$]*)/gi:/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|--[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b)|([A-Za-z_$][\w$]*)/gi;let cursor=0,match;while((match=pattern.exec(text))){if(match.index>cursor)root.append(document.createTextNode(text.slice(cursor,match.index)));if(match[1])token(root,"comment",match[0]);else if(match[2])token(root,"string",match[0]);else if(match[3])token(root,"number",match[0]);else if(keywords?.has(language==="sql"?match[0].toUpperCase():match[0]))token(root,"keyword",match[0]);else root.append(document.createTextNode(match[0]));cursor=pattern.lastIndex}if(cursor<text.length)root.append(document.createTextNode(text.slice(cursor)))}
function highlightMarkup(root,text){const pattern=/(<!--[\s\S]*?-->)|(<\/?)([\w:-]+)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')/g;let cursor=0,match;while((match=pattern.exec(text))){if(match.index>cursor)root.append(document.createTextNode(text.slice(cursor,match.index)));if(match[1])token(root,"comment",match[1]);else if(match[2]){token(root,"punctuation",match[2]);token(root,"tag",match[3])}else{token(root,"attribute",match[4]);root.append(document.createTextNode(match[5]));token(root,"string",match[6])}cursor=pattern.lastIndex}if(cursor<text.length)root.append(document.createTextNode(text.slice(cursor)))}
function highlightCode(code,text,rawLanguage){const language=languageName(rawLanguage);code.dataset.language=language;if(language==="markup")highlightMarkup(code,text);else if(language==="json"||language==="yaml"||language==="css"||KEYWORDS[language])highlightGeneric(code,text,language);else if(language==="diff")for(const [index,line] of text.split("\n").entries()){if(index)code.append(document.createTextNode("\n"));token(code,line.startsWith("+")?"inserted":line.startsWith("-")?"deleted":"plain",line)}else code.textContent=text;return language}

function isEscaped(text,index){let slashes=0;while(index-slashes-1>=0&&text[index-slashes-1]==="\\")slashes++;return slashes%2===1}
function findInlineMath(text,start){
  for(let index=start;index<text.length;index++){
    if(text[index]==="\\"&&text[index+1]==="("&&!isEscaped(text,index)){
      for(let end=index+2;end<text.length-1;end++)if(text[end]==="\\"&&text[end+1]===")"&&!isEscaped(text,end))return{start:index,end:end+2,formula:text.slice(index+2,end),raw:text.slice(index,end+2)};
    }
    if(text[index]!=="$"||text[index+1]==="$"||isEscaped(text,index)||/\s/.test(text[index+1]||"")||/[\p{L}\p{N}]/u.test(text[index-1]||""))continue;
    for(let end=index+1;end<text.length;end++)if(text[end]==="$"&&!isEscaped(text,end)){
      if(text[end+1]!=="$"&&!/[\s\\]/.test(text[end-1]||""))return{start:index,end:end+1,formula:text.slice(index+1,end),raw:text.slice(index,end+1)};
      break;
    }
  }
  return null;
}

function appendMath(root,formula,displayMode,raw){
  const node=document.createElement(displayMode?"div":"span");node.className=displayMode?"math-display":"math-inline";
  try{
    if(!globalThis.katex?.render)throw new Error("KaTeX 未加载");
    globalThis.katex.render(formula,node,{displayMode,throwOnError:true,strict:"ignore",trust:false,maxSize:10,maxExpand:1000});
  }catch{node.classList.add("math-error");node.textContent=raw;node.title=t("error.formula")}
  root.append(node);
}

function appendInline(root,text){
  const pattern=/(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)|\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
  let cursor=0;
  while(cursor<text.length){
    pattern.lastIndex=cursor;const match=pattern.exec(text),math=findInlineMath(text,cursor);
    if(math&&(!match||math.start<=match.index)){if(math.start>cursor)root.append(document.createTextNode(text.slice(cursor,math.start)));appendMath(root,math.formula,false,math.raw);cursor=math.end;continue}
    if(!match)break;
    if(match.index>cursor)root.append(document.createTextNode(text.slice(cursor,match.index)));
    if(match[1]){const code=document.createElement("code");code.textContent=match[2];root.append(code)}
    else if(match[3]!==undefined){const src=safeRemoteImageHref(match[4]);if(!src)root.append(document.createTextNode(match[0]));else{const image=document.createElement("img");image.src=src;image.alt=match[3];image.loading="lazy";image.decoding="async";image.referrerPolicy="no-referrer";root.append(image)}}
    else if(match[5]!==undefined){
      const href=safeHref(match[6]);
      if(!href){root.append(document.createTextNode(match[5]))}
      else{const link=document.createElement("a");link.textContent=match[5];link.href=href;if(/^https?:/i.test(href)){link.target="_blank";link.rel="noopener noreferrer"}root.append(link)}
    }else{const node=document.createElement(match[7]||match[8]?"strong":match[9]?"s":"em");appendInline(node,match[7]||match[8]||match[9]||match[10]||match[11]||"");root.append(node)}
    cursor=pattern.lastIndex;
  }
  if(cursor<text.length)root.append(document.createTextNode(text.slice(cursor)));
}

export function safeHref(raw){
  const value=String(raw||"").trim();
  if(!value||/[\u0000-\u001f\u007f]/.test(value))return null;
  if(value.startsWith("//"))return null;
  if(value.startsWith("#")||value.startsWith("./")||value.startsWith("../")||value.startsWith("/")&&!value.startsWith("//"))return value;
  try{const url=new URL(value,"https://panel.invalid/");return SAFE_PROTOCOLS.has(url.protocol)?value:null}catch{return null}
}

export function safeRemoteImageHref(raw){
  const value=String(raw||"").trim();if(!value||/[\u0000-\u001f\u007f]/.test(value))return null;
  try{const url=new URL(value);return url.protocol==="https:"||url.protocol==="http:"?url.href:null}catch{return null}
}

function codeBlock(lines,start){
  const opening=/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/.exec(lines[start]);if(!opening)return null;
  const marker=opening[1][0],minimum=opening[1].length,body=[];let index=start+1;
  while(index<lines.length&&!new RegExp(`^\\s*${marker}{${minimum},}\\s*$`).test(lines[index]))body.push(lines[index++]);
  return{end:index<lines.length?index+1:index,language:opening[2]||"",text:body.join("\n")};
}

function mathBlock(lines,start){
  const line=lines[start].trim(),single=/^\$\$([\s\S]+)\$\$$/.exec(line)||/^\\\[([\s\S]+)\\\]$/.exec(line);
  if(single)return{end:start+1,formula:single[1].trim(),raw:line};
  const close=line==="$$"?"$$":line==="\\["?"\\]":null;if(!close)return null;
  const body=[];let index=start+1;while(index<lines.length&&lines[index].trim()!==close)body.push(lines[index++]);
  if(index===lines.length)return null;
  return{end:index+1,formula:body.join("\n").trim(),raw:[line,...body,close].join("\n")};
}

function addCodeCopy(pre,text,language){
  const wrap=document.createElement("div"),button=document.createElement("button");wrap.className="code-block";if(language){const label=document.createElement("span");label.className="code-language";label.textContent=LANGUAGE_LABELS[language]||language;wrap.append(label)}button.type="button";button.className="copy-code";button.textContent=t("error.copyCode");button.onclick=()=>copyText(text,button,t("error.copyDone"));wrap.append(button,pre);return wrap;
}

export async function copyText(text,button,success=t("error.copyDone")){
  const original=button?.textContent;
  try{await navigator.clipboard.writeText(String(text));if(button)button.textContent=success}
  catch{if(button)button.textContent=t("error.copy")}
  if(button)setTimeout(()=>{button.textContent=original},1500);
}

export function renderMarkdown(text){
  const root=document.createElement("div");root.className="markdown";
  const lines=String(text??"").replace(/\r\n?/g,"\n").split("\n");let index=0;
  while(index<lines.length){
    if(!lines[index].trim()){index++;continue}
    const fenced=codeBlock(lines,index);
    if(fenced){const pre=document.createElement("pre"),code=document.createElement("code"),language=fenced.language?highlightCode(code,fenced.text,fenced.language):(code.textContent=fenced.text,"");pre.append(code);root.append(addCodeCopy(pre,fenced.text,language));index=fenced.end;continue}
    const formula=mathBlock(lines,index);
    if(formula){appendMath(root,formula.formula,true,formula.raw);index=formula.end;continue}
    const heading=/^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if(heading){const node=document.createElement(`h${heading[1].length}`);appendInline(node,heading[2]);root.append(node);index++;continue}
    if(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])){root.append(document.createElement("hr"));index++;continue}
    if(/^>\s?/.test(lines[index])){const quote=document.createElement("blockquote"),parts=[];while(index<lines.length&&/^>\s?/.test(lines[index]))parts.push(lines[index++].replace(/^>\s?/,""));quote.append(renderMarkdown(parts.join("\n")));root.append(quote);continue}
    const list=/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);
    if(list){const ordered=Boolean(list[2]),node=document.createElement(ordered?"ol":"ul");if(ordered&&Number(list[2])!==1)node.start=Number(list[2]);while(index<lines.length){const item=/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);if(!item||Boolean(item[2])!==ordered)break;const li=document.createElement("li"),task=/^\[([ xX])\]\s*(.*)$/.exec(item[3]);if(task){node.classList.add("task-list");li.className="task-list-item";const checkbox=document.createElement("input");checkbox.type="checkbox";checkbox.checked=task[1].toLowerCase()==="x";checkbox.disabled=true;li.append(checkbox);appendInline(li,task[2])}else appendInline(li,item[3]);node.append(li);index++}root.append(node);continue}
    if(index+1<lines.length&&/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[index+1])&&lines[index].includes("|")){
      const table=document.createElement("table"),head=document.createElement("thead"),body=document.createElement("tbody"),split=line=>line.trim().replace(/^\||\|$/g,"").split("|").map(cell=>cell.trim());const header=document.createElement("tr");for(const cell of split(lines[index])){const th=document.createElement("th");appendInline(th,cell);header.append(th)}head.append(header);index+=2;while(index<lines.length&&lines[index].includes("|")&&lines[index].trim()){const row=document.createElement("tr");for(const cell of split(lines[index++])){const td=document.createElement("td");appendInline(td,cell);row.append(td)}body.append(row)}table.append(head,body);root.append(table);continue
    }
    const paragraph=[];while(index<lines.length&&lines[index].trim()&&!codeBlock(lines,index)&&!mathBlock(lines,index)&&!/^#{1,6}\s+/.test(lines[index])&&!/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])&&!/^>\s?/.test(lines[index])&&!/^\s*(?:[-+*]|\d+\.)\s+/.test(lines[index]))paragraph.push(lines[index++]);const node=document.createElement("p");paragraph.forEach((line,i)=>{if(i)node.append(document.createElement("br"));appendInline(node,line)});root.append(node);
  }
  return root;
}
