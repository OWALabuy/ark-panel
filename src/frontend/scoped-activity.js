export function createScopedActivity(){
  const active=new Set();
  return Object.freeze({
    has(key){return Boolean(key)&&active.has(String(key))},
    start(key){key=String(key||"");if(!key||active.has(key))return false;active.add(key);return true},
    finish(key){return active.delete(String(key||""))},
    move(from,to){from=String(from||"");to=String(to||"");if(!from||!to||!active.has(from)||active.has(to))return false;active.delete(from);active.add(to);return true}
  })
}
