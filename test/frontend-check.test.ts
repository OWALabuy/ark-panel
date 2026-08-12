import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("frontend response DTOs reject misspelled fields at the real api call site", async t => {
  const root = await mkdtemp(join(tmpdir(), "ark-panel-frontend-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp("src/frontend", join(root, "src/frontend"), { recursive: true });
  await cp("tsconfig.frontend.json", join(root, "tsconfig.frontend.json"));

  const tsc = join(process.cwd(), "node_modules/typescript/bin/tsc");
  await execute(process.execPath, [tsc, "-p", "tsconfig.frontend.json"], { cwd: root });

  const app = join(root, "src/frontend/app.js"), source = await readFile(app, "utf8");
  const mutated = source.replace("created.recordId", "created.notARecordId");
  assert.notEqual(mutated, source, "expected a typed SessionRef response field to mutate");
  await writeFile(app, mutated);

  await assert.rejects(
    execute(process.execPath, [tsc, "-p", "tsconfig.frontend.json"], { cwd: root }),
    error => {
      const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
      assert.notEqual(failure.code, 0);
      assert.match(`${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, /Property 'notARecordId' does not exist on type 'SessionRefDto'/);
      return true;
    }
  );
});
