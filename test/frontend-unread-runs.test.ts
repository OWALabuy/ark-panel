import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type UnreadStatus = "completed" | "failed";
type UnreadRun = Readonly<{ agentId: string; status: UnreadStatus }>;
type Store = Readonly<{
  key: string;
  size: number;
  get(recordId: unknown): UnreadRun | undefined;
  values(): readonly UnreadRun[];
  mark(run: { recordId?: unknown; agentId?: unknown; status?: unknown }, context: { activeRecordId?: unknown; documentHidden?: unknown; fallbackAgentId?: unknown }): boolean;
  clear(recordId: unknown): boolean;
  reload(): void;
}>;
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

const KEY = "ark-panel:unread-runs:v1";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

class FaultStorage extends MemoryStorage {
  failGet = false;
  failSet = false;
  failRemove = false;
  override getItem(key: string) { if (this.failGet) throw new Error("get blocked"); return super.getItem(key); }
  override setItem(key: string, value: string) { if (this.failSet) throw new Error("set blocked"); super.setItem(key, value); }
  override removeItem(key: string) { if (this.failRemove) throw new Error("remove blocked"); super.removeItem(key); }
}

async function loadFactory(): Promise<(dependencies: { storage: Storage }) => Store> {
  const url = pathToFileURL(join(process.cwd(), "src/frontend/unread-runs.js")).href;
  const module = await import(`${url}?unread-runs`);
  assert.equal(module.UNREAD_RUNS_KEY, KEY);
  return module.createUnreadRunStore as (dependencies: { storage: Storage }) => Store;
}

async function fixture(storage: Storage = new MemoryStorage()) {
  const createUnreadRunStore = await loadFactory();
  return { storage, store: createUnreadRunStore({ storage }) };
}

test("unread run v1 storage restores only valid terminal entries", async () => {
  const storage = new MemoryStorage();
  storage.setItem(KEY, JSON.stringify({
    completed: { agentId: "agent-a", status: "completed" },
    failed: { agentId: "agent-b", status: "failed" },
    "": { agentId: "agent-c", status: "completed" },
    noAgent: { agentId: "", status: "completed" },
    running: { agentId: "agent-d", status: "running" },
    missing: null
  }));
  const { store } = await fixture(storage);

  assert.equal(store.key, KEY);
  assert.equal(store.size, 2);
  assert.deepEqual(store.get("completed"), { agentId: "agent-a", status: "completed" });
  assert.deepEqual(store.get("failed"), { agentId: "agent-b", status: "failed" });
  assert.equal(store.get("running"), undefined);
});

test("corrupt, array, and unreadable storage fail soft to an empty store", async () => {
  for (const serialized of ["{broken", "[]", "null", "42"]) {
    const storage = new MemoryStorage();
    storage.setItem(KEY, serialized);
    assert.equal((await fixture(storage)).store.size, 0, serialized);
  }

  const storage = new FaultStorage();
  storage.setItem(KEY, JSON.stringify({ old: { agentId: "agent-a", status: "completed" } }));
  const { store } = await fixture(storage);
  assert.equal(store.size, 1);
  storage.failGet = true;
  assert.doesNotThrow(() => store.reload());
  assert.equal(store.size, 0);
});

test("mark records only terminal runs outside the visible active session", async () => {
  const storage = new MemoryStorage(), { store } = await fixture(storage);

  assert.equal(store.mark({ recordId: "active", agentId: "agent-a", status: "completed" }, { activeRecordId: "active", documentHidden: false, fallbackAgentId: "fallback" }), false);
  assert.equal(store.mark({ recordId: "active", agentId: "agent-a", status: "completed" }, { activeRecordId: "active", documentHidden: true, fallbackAgentId: "fallback" }), true);
  assert.equal(store.mark({ recordId: "other", agentId: "", status: "failed" }, { activeRecordId: "active", documentHidden: false, fallbackAgentId: "agent-fallback" }), true);
  assert.equal(store.mark({ recordId: "running", agentId: "agent-a", status: "running" }, { activeRecordId: "active", documentHidden: true, fallbackAgentId: "fallback" }), false);
  assert.equal(store.mark({ recordId: "", agentId: "agent-a", status: "failed" }, { activeRecordId: "active", documentHidden: true, fallbackAgentId: "fallback" }), false);
  assert.equal(store.mark({ recordId: "missing-agent", status: "failed" }, { activeRecordId: "active", documentHidden: true, fallbackAgentId: "" }), false);

  assert.deepEqual(store.get("active"), { agentId: "agent-a", status: "completed" });
  assert.deepEqual(store.get("other"), { agentId: "agent-fallback", status: "failed" });
  assert.equal(storage.values.get(KEY), '{"active":{"agentId":"agent-a","status":"completed"},"other":{"agentId":"agent-fallback","status":"failed"}}');
});

test("get and values return immutable detached snapshots", async () => {
  const { store } = await fixture();
  store.mark({ recordId: "one", agentId: "agent-a", status: "completed" }, { activeRecordId: "", documentHidden: false, fallbackAgentId: "" });

  const first = store.get("one")!;
  const values = store.values();
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(values), true);
  assert.equal(Object.isFrozen(values[0]), true);
  assert.notEqual(first, store.get("one"));
  assert.notEqual(values, store.values());
  assert.throws(() => { (first as { agentId: string }).agentId = "mutated"; }, TypeError);
  assert.throws(() => { (values as UnreadRun[]).splice(0, 1); }, TypeError);
  assert.deepEqual(store.get("one"), { agentId: "agent-a", status: "completed" });
});

test("write and remove failures keep the in-memory state fail-soft", async () => {
  const storage = new FaultStorage(), { store } = await fixture(storage);
  storage.failSet = true;
  assert.doesNotThrow(() => store.mark({ recordId: "one", agentId: "agent-a", status: "completed" }, { activeRecordId: "", documentHidden: false, fallbackAgentId: "" }));
  assert.equal(store.size, 1);
  assert.equal(storage.values.has(KEY), false);

  storage.failSet = false;
  store.mark({ recordId: "two", agentId: "agent-b", status: "failed" }, { activeRecordId: "", documentHidden: false, fallbackAgentId: "" });
  storage.failRemove = true;
  assert.equal(store.clear("one"), true);
  assert.equal(store.clear("two"), true);
  assert.equal(store.size, 0);
  assert.equal(storage.values.has(KEY), true, "failed removal leaves only the durable copy behind");
  assert.equal(store.clear("unknown"), false);
});

test("clear persists removals and reload replaces state after a storage event", async () => {
  const storage = new MemoryStorage(), { store } = await fixture(storage);
  store.mark({ recordId: "one", agentId: "agent-a", status: "completed" }, { activeRecordId: "", documentHidden: false, fallbackAgentId: "" });
  store.mark({ recordId: "two", agentId: "agent-b", status: "failed" }, { activeRecordId: "", documentHidden: false, fallbackAgentId: "" });
  assert.equal(store.clear("one"), true);
  assert.equal(storage.values.get(KEY), '{"two":{"agentId":"agent-b","status":"failed"}}');

  storage.setItem(KEY, '{"external":{"agentId":"agent-c","status":"completed"}}');
  store.reload();
  assert.equal(store.size, 1);
  assert.equal(store.get("two"), undefined);
  assert.deepEqual(store.get("external"), { agentId: "agent-c", status: "completed" });
  assert.equal(store.clear("external"), true);
  assert.equal(storage.values.has(KEY), false);
});
