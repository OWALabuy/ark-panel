import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { watch } from "node:fs";
import { createBackup, restoreBackup, verifyBackup } from "../src/ops/backup.js";

test("离线备份可校验并原子恢复到新 dataRoot", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-backup-test-"));
  try {
    const data = join(root, "data"), backups = join(root, "backups"), restored = join(root, "restored");
    await mkdir(join(data, "sessions", "claude", "one"), { recursive: true }); await mkdir(backups);
    await writeFile(join(data, "sessions", "claude", "one", "metadata.json"), "metadata\n");
    await writeFile(join(data, "sessions", "claude", "one", "transcript.jsonl"), "transcript\n");
    const path = await createBackup(data, backups, "snapshot-1"), manifest = await verifyBackup(path);
    assert.equal(manifest.files.length, 2); await restoreBackup(path, restored);
    assert.equal(await readFile(join(restored, "sessions", "claude", "one", "transcript.jsonl"), "utf8"), "transcript\n");
    await assert.rejects(restoreBackup(path, restored), /必须不存在/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("保留空目录、恢复权限并拒绝超大 manifest", async()=>{
  const root=await mkdtemp(join(tmpdir(),"panel-backup-limits-"));try{const data=join(root,"data"),backups=join(root,"backups"),restored=join(root,"restored");await mkdir(join(data,"empty","nested"),{recursive:true});await mkdir(backups);
    const backup=await createBackup(data,backups,"empty");await restoreBackup(backup,restored);assert.ok((await lstat(join(restored,"empty","nested"))).isDirectory());assert.equal((await lstat(restored)).mode&0o777,0o700);
    const huge=join(root,"huge");await mkdir(join(huge,"data"),{recursive:true});const handle=await open(join(huge,"manifest.json"),"w");await handle.truncate(4*1024*1024+1);await handle.close();await assert.rejects(verifyBackup(huge),/资源上限/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("restore 的目标锁阻止并发恢复",async()=>{const root=await mkdtemp(join(tmpdir(),"panel-backup-lock-"));try{const data=join(root,"data"),backups=join(root,"backups"),target=join(root,"target");await mkdir(data);await mkdir(backups);await writeFile(join(data,"x"),"x");const backup=await createBackup(data,backups,"one");await writeFile(join(root,".target.restore.lock"),"");await assert.rejects(restoreBackup(backup,target),/EEXIST/);}finally{await rm(root,{recursive:true,force:true})}});

test("verify 拒绝 data symlink，restore 会复核 verify 后变化的内容",async()=>{const root=await mkdtemp(join(tmpdir(),"panel-backup-race-"));try{const data=join(root,"data"),backups=join(root,"backups"),target=join(root,"target");await mkdir(data);await mkdir(backups);await writeFile(join(data,"zzz"),"original");const backup=await createBackup(data,backups,"one");
    const watcher=watch(root);let changed=false;watcher.on("change",(_event,name)=>{if(!changed&&name?.toString()===".target.restore.lock"){changed=true;void writeFile(join(backup,"data","zzz"),"tampered")}});
    await assert.rejects(restoreBackup(backup,target),/恢复前备份校验失败|备份校验失败/);watcher.close();
    await rm(join(backup,"data"),{recursive:true});await symlink(data,join(backup,"data"));await assert.rejects(verifyBackup(backup),/data .*安全目录|data 不是安全目录/);
  }finally{await rm(root,{recursive:true,force:true})}});

test("篡改、额外文件和 symlink 均使备份失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-backup-unsafe-"));
  try {
    const data = join(root, "data"), backups = join(root, "backups"); await mkdir(data); await mkdir(backups); await writeFile(join(data, "safe"), "one");
    const path = await createBackup(data, backups, "snapshot"); await writeFile(join(path, "data", "safe"), "two");
    await assert.rejects(verifyBackup(path), /校验失败/);
    await writeFile(join(path, "data", "extra"), "extra"); await assert.rejects(verifyBackup(path), /校验失败|清单不一致/);
    await rm(path, { recursive: true }); await symlink("/tmp", join(data, "link"));
    await assert.rejects(createBackup(data, backups, "snapshot-2"), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("拒绝目录重叠及 OpenClaw agent 路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-backup-paths-"));
  try {
    const data = join(root, "data"); await mkdir(data); await mkdir(join(data, "backups"));
    await assert.rejects(createBackup(data, join(data, "backups"), "snapshot"), /不得重叠/);
    await assert.rejects(restoreBackup(join(root, ".openclaw", "agents", "x", "backup"), join(root, "new")), /OpenClaw/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
