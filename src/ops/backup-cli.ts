import { createBackup, restoreBackup, verifyBackup } from "./backup.js";
const [command, first, second, third] = process.argv.slice(2);
if (!command || !first) throw new Error("用法: npm run backup -- backup DATA_ROOT BACKUPS_ROOT [NAME] | verify BACKUP | restore BACKUP NEW_DATA_ROOT");
if (command === "backup" && second) process.stdout.write(await createBackup(first, second, third) + "\n");
else if (command === "verify") process.stdout.write(JSON.stringify(await verifyBackup(first)) + "\n");
else if (command === "restore" && second) { await restoreBackup(first, second); process.stdout.write(second + "\n"); }
else throw new Error("备份命令参数无效");
