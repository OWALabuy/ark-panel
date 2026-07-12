const SAFE_PROTOCOLS=new Set(["http:","https:","mailto:"]);

function appendInline(root,text){
  const pattern=/(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)|\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
  let cursor=0,match;
  while((match=pattern.exec(text))){
    if(match.index>cursor)root.append(document.createTextNode(text.slice(cursor,match.index)));
    if(match[1]){const code=document.createElement("code");code.textContent=match[2];root.append(code)}
    else if(match[3]!==undefined){root.append(document.createTextNode(match[0]))}
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

function codeBlock(lines,start){
  const opening=/^\s*(`{3,}|~{3,})\s*([^\s`]*)?.*$/.exec(lines[start]);if(!opening)return null;
  const marker=opening[1][0],minimum=opening[1].length,body=[];let index=start+1;
  while(index<lines.length&&!new RegExp(`^\\s*${marker}{${minimum},}\\s*$`).test(lines[index]))body.push(lines[index++]);
  return{end:index<lines.length?index+1:index,language:opening[2]||"",text:body.join("\n")};
}

function addCodeCopy(pre,text){
  const wrap=document.createElement("div"),button=document.createElement("button");wrap.className="code-block";button.type="button";button.className="copy-code";button.textContent="复制代码";button.onclick=()=>copyText(text,button,"已复制");wrap.append(button,pre);return wrap;
}

export async function copyText(text,button,success="已复制"){
  const original=button?.textContent;
  try{await navigator.clipboard.writeText(String(text));if(button)button.textContent=success}
  catch{if(button)button.textContent="复制失败"}
  if(button)setTimeout(()=>{button.textContent=original},1500);
}

export function renderMarkdown(text){
  const root=document.createElement("div");root.className="markdown";
  const lines=String(text??"").replace(/\r\n?/g,"\n").split("\n");let index=0;
  while(index<lines.length){
    if(!lines[index].trim()){index++;continue}
    const fenced=codeBlock(lines,index);
    if(fenced){const pre=document.createElement("pre"),code=document.createElement("code");if(fenced.language)code.dataset.language=fenced.language;code.textContent=fenced.text;pre.append(code);root.append(addCodeCopy(pre,fenced.text));index=fenced.end;continue}
    const heading=/^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if(heading){const node=document.createElement(`h${heading[1].length}`);appendInline(node,heading[2]);root.append(node);index++;continue}
    if(/^>\s?/.test(lines[index])){const quote=document.createElement("blockquote"),parts=[];while(index<lines.length&&/^>\s?/.test(lines[index]))parts.push(lines[index++].replace(/^>\s?/,""));quote.append(renderMarkdown(parts.join("\n")));root.append(quote);continue}
    const list=/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);
    if(list){const ordered=Boolean(list[2]),node=document.createElement(ordered?"ol":"ul");if(ordered&&Number(list[2])!==1)node.start=Number(list[2]);while(index<lines.length){const item=/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);if(!item||Boolean(item[2])!==ordered)break;const li=document.createElement("li");appendInline(li,item[3]);node.append(li);index++}root.append(node);continue}
    if(index+1<lines.length&&/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[index+1])&&lines[index].includes("|")){
      const table=document.createElement("table"),head=document.createElement("thead"),body=document.createElement("tbody"),split=line=>line.trim().replace(/^\||\|$/g,"").split("|").map(cell=>cell.trim());const header=document.createElement("tr");for(const cell of split(lines[index])){const th=document.createElement("th");appendInline(th,cell);header.append(th)}head.append(header);index+=2;while(index<lines.length&&lines[index].includes("|")&&lines[index].trim()){const row=document.createElement("tr");for(const cell of split(lines[index++])){const td=document.createElement("td");appendInline(td,cell);row.append(td)}body.append(row)}table.append(head,body);root.append(table);continue
    }
    const paragraph=[];while(index<lines.length&&lines[index].trim()&&!codeBlock(lines,index)&&!/^#{1,6}\s+/.test(lines[index])&&!/^>\s?/.test(lines[index])&&!/^\s*(?:[-+*]|\d+\.)\s+/.test(lines[index]))paragraph.push(lines[index++]);const node=document.createElement("p");paragraph.forEach((line,i)=>{if(i)node.append(document.createElement("br"));appendInline(node,line)});root.append(node);
  }
  return root;
}
