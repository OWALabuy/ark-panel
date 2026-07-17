export function contextStatusClass(percentage){
  const value=Number(percentage);
  if(!Number.isFinite(value))return"";
  return value>=90?"context-danger":value>=70?"context-warning":"";
}

export function relativeConversationTime(value,now=Date.now()){
  const time=new Date(value).getTime();
  if(!Number.isFinite(time))return"";
  const seconds=Math.max(0,Math.round((now-time)/1000));
  if(seconds<60)return"刚刚活跃";
  const minutes=Math.floor(seconds/60);if(minutes<60)return`${minutes} 分钟前活跃`;
  const hours=Math.floor(minutes/60);if(hours<24)return`${hours} 小时前活跃`;
  const days=Math.floor(hours/24);if(days<30)return`${days} 天前活跃`;
  return`${new Date(time).toLocaleDateString()}活跃`;
}
