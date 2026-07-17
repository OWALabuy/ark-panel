export function contextStatusClass(percentage){
  const value=Number(percentage);
  if(!Number.isFinite(value))return"";
  return value>=90?"context-danger":value>=70?"context-warning":"";
}

export function relativeConversationTime(value,now=Date.now(),locale="zh-CN",translate){
  const time=new Date(value).getTime();
  if(!Number.isFinite(time))return"";
  const seconds=Math.max(0,Math.round((now-time)/1000));
  const text=translate??((key,params={})=>({"status.justNow":"刚刚活跃","status.minutesAgo":`${params.count} 分钟前活跃`,"status.hoursAgo":`${params.count} 小时前活跃`,"status.daysAgo":`${params.count} 天前活跃`,"status.date":`${params.date}活跃`}[key]));
  if(seconds<60)return text("status.justNow");
  const minutes=Math.floor(seconds/60);if(minutes<60)return text("status.minutesAgo",{count:minutes});
  const hours=Math.floor(minutes/60);if(hours<24)return text("status.hoursAgo",{count:hours});
  const days=Math.floor(hours/24);if(days<30)return text("status.daysAgo",{count:days});
  return text("status.date",{date:new Date(time).toLocaleDateString(locale)});
}
