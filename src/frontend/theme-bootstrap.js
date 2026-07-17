(()=>{
  try{
    const value=JSON.parse(localStorage.getItem("ark-panel:appearance:v1")||"null");
    const themes=new Set(["system","light","dark","gruvbox-dark-medium","gruvbox-light-medium"]);
    const accents=new Set(["default","blue","green","red","yellow","magenta","cyan"]);
    if(value&&themes.has(value.theme))document.documentElement.dataset.theme=value.theme;
    if(value&&accents.has(value.accent))document.documentElement.dataset.accent=value.accent;
    const locale=localStorage.getItem("ark-panel:locale:v1");
    if(locale==="zh-CN"||locale==="en")document.documentElement.lang=locale;
  }catch{}
})();
