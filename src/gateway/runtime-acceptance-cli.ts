import { runRuntimeAcceptance } from "./runtime-acceptance.js";
const agents=process.argv.slice(2);if(!agents.length)throw new Error("用法：npm run test:runtime-acceptance -- panel-claude-runtime [panel-main-runtime]");let failed=false;
for(const agent of agents){const result=await runRuntimeAcceptance(agent);process.stdout.write(JSON.stringify(result)+"\n");if(!result.passed)failed=true}if(failed)process.exitCode=2;
