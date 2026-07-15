import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const THEMES=["system","light","dark","gruvbox-dark-medium","gruvbox-light-medium"] as const;
const ACCENTS=["default","blue","green","red","yellow","magenta","cyan"] as const;

function luminance(hex: string): number {
  const expanded=hex.length===4?`#${[...hex.slice(1)].map(value=>value+value).join("")}`:hex;
  const channels=expanded.slice(1).match(/.{2}/g)?.map(value=>Number.parseInt(value,16)/255)??[];
  assert.equal(channels.length,3,`invalid color ${hex}`);
  const linear=channels.map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
  return 0.2126*linear[0]!+0.7152*linear[1]!+0.0722*linear[2]!;
}

function contrast(left: string,right: string): number {
  const [lighter,darker]=[luminance(left),luminance(right)].sort((a,b)=>b-a);
  return (lighter!+0.05)/(darker!+0.05);
}

test("all shipped theme accent foreground pairs meet WCAG AA normal-text contrast",async()=>{
  const styles=await readFile("src/frontend/styles.css","utf8");
  assert.match(styles,/:root:not\(\[data-accent\]\)\{--accent:var\(--palette-default\);--on-accent:var\(--palette-default-on\)\}/,"first visit must use the accessible default pair");
  const rules=[...styles.matchAll(/([^{}]+)\{([^{}]+)\}/g)].map(match=>({selector:match[1]!,body:match[2]!}));

  for(const theme of THEMES){
    const palettes=rules.filter(rule=>rule.selector.includes(`[data-theme="${theme}"]`)&&rule.body.includes("--palette-default:"));
    assert.ok(palettes.length>=1,`${theme} has no accessible palette`);
    if(theme==="system")assert.equal(palettes.length,2,"system must cover light and dark color schemes");
    for(const palette of palettes){
      const values=new Map([...palette.body.matchAll(/--([\w-]+):\s*(#[\da-f]{3,8})/gi)].map(match=>[match[1]!,match[2]!]));
      for(const accent of ACCENTS){
        const background=values.get(`palette-${accent}`),foreground=values.get(`palette-${accent}-on`);
        assert.ok(background&&foreground,`${theme}/${accent} palette is incomplete`);
        assert.ok(contrast(background,foreground)>=4.5,`${theme}/${accent} contrast is ${contrast(background,foreground).toFixed(2)}`);
      }
    }
  }
});
