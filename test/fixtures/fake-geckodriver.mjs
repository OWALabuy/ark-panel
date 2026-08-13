import { createServer } from "node:http";

const reportArgument = process.argv.find(argument => argument.startsWith("--report-port="));
const reportPort = reportArgument ? Number(reportArgument.slice("--report-port=".length)) : undefined;
const exitArgument = process.argv.find(argument => argument.startsWith("--exit-ms="));
const exitMs = exitArgument ? Number(exitArgument.slice("--exit-ms=".length)) : undefined;
const server = createServer((request, response) => {
  if (request.url === "/status") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: { ready: true, message: "fixture ready" } }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(2);
  process.stderr.write(`fixture\tgeckodriver\tINFO\tListening on 127.0.0.1:${reportPort || address.port}\n`);
  if (Number.isSafeInteger(exitMs) && exitMs >= 0) setTimeout(() => process.exit(0), exitMs);
});
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
