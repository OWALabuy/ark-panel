import { spawn } from "node:child_process";

const executable = process.argv[2];
const targetArguments = process.argv.slice(3);
let started = false;

function abortBeforeStart() {
  if (!started) process.exit(0);
}

process.on("disconnect", abortBeforeStart);
process.on("message", message => {
  if (message?.type === "ABORT") {
    abortBeforeStart();
    return;
  }
  if (message?.type !== "START" || started) return;
  started = true;
  if (!executable) process.exit(127);
  const target = spawn(executable, targetArguments, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  target.once("spawn", () => {
    if (process.connected) process.send?.({ type: "TARGET_STARTED" });
  });
  target.stdout?.pipe(process.stdout);
  target.stderr?.pipe(process.stderr);
  target.once("error", () => {
    if (process.connected) process.send?.({ type: "TARGET_SPAWN_FAILED" });
  });
  target.once("close", (code, signal) => {
    if (process.connected) process.disconnect();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
});

if (process.connected) process.send?.({ type: "LAUNCHER_READY" });
