import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

type ScopedActivity = {
  has(key: string): boolean;
  start(key: string): boolean;
  finish(key: string): boolean;
  move(from: string, to: string): boolean;
};

async function loadFactory(): Promise<() => ScopedActivity> {
  const url = pathToFileURL(join(process.cwd(), "src/frontend/scoped-activity.js")).href;
  return (await import(url)).createScopedActivity as () => ScopedActivity;
}

test("scoped activity only marks its owning conversation busy", async () => {
  const createScopedActivity = await loadFactory(), activity = createScopedActivity();

  assert.equal(activity.start("session:a"), true);
  assert.equal(activity.has("session:a"), true);
  assert.equal(activity.has("session:b"), false);
  assert.equal(activity.start("session:a"), false);
  assert.equal(activity.finish("session:a"), true);
  assert.equal(activity.has("session:a"), false);
});

test("scoped activity transfers a new-session draft without locking other drafts", async () => {
  const createScopedActivity = await loadFactory(), activity = createScopedActivity();

  assert.equal(activity.start("new:agent-a"), true);
  assert.equal(activity.move("new:agent-a", "session:created"), true);
  assert.equal(activity.has("new:agent-a"), false);
  assert.equal(activity.has("session:created"), true);
  assert.equal(activity.has("new:agent-b"), false);
});
