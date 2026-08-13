import { writeFile } from "node:fs/promises";

const marker = process.argv[2];
if (!marker) process.exit(2);
await writeFile(marker, "started", { flag: "wx", mode: 0o600 });
setTimeout(() => process.exit(0), 10_000);
