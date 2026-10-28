import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { SelfHostedStore } from "../src/self-hosted/store";

const stores: SelfHostedStore[] = [];
const folders: string[] = [];
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-storage-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  const store = new SelfHostedStore(path);
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession();
  return { store, a, b, path };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-")
    )
      throw new Error(
        "Refuse cleanup outside the named test temporary directories.",
      );
    rmSync(folder, { recursive: true, force: true });
  }
});

test("owned threads and reviewed memories survive a real database reopen", () => {
  const { store, a, b, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "message-1",
    "Synthetic hello",
  );
  store.completeRun(a.owner, run.id, "Synthetic answer");
  store.saveMemory(a.owner, "Use Tamil replies", true);
  expect(store.listThreads(b.owner)).toEqual([]);
  expect(() => store.thread(b.owner, thread.id)).toThrow("not found");
  expect(() => store.deleteThread(b.owner, thread.id)).toThrow("not found");
  expect(store.memories(b.owner)).toEqual([]);
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(
    reopened.thread(a.owner, thread.id).messages.map((m) => m.content),
  ).toEqual(["Synthetic hello", "Synthetic answer"]);
  expect(reopened.memories(a.owner)[0].content).toBe("Use Tamil replies");
  expect(reopened.session(a.token)?.owner).toBe(a.owner);
});

test("duplicate IDs do not create another run and pending work is not replayed", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(a.owner, thread.id, "message-1", "Hello");
  const duplicate = store.beginRun(a.owner, thread.id, "message-1", "Hello");
  expect(duplicate.id).toBe(run.id);
  expect(duplicate.fresh).toBe(false);
  expect(() =>
    store.beginRun(a.owner, thread.id, "message-1", "Changed"),
  ).toThrow("conflicts");
  expect(() =>
    store.beginRun(a.owner, thread.id, "message-2", "Second"),
  ).toThrow("running");
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(
    reopened.beginRun(a.owner, thread.id, "message-1", "Hello").state,
  ).toBe("interrupted");
  expect(reopened.thread(a.owner, thread.id).messages).toHaveLength(1);
  expect(reopened.thread(a.owner, thread.id).lastRun?.state).toBe(
    "interrupted",
  );
});

test("a send reserves room for its reply after a failed run near the message limit", () => {
  const { store, a } = world();
  const thread = store.createThread(a.owner, "saathi");
  for (let i = 0; i < 49; i++) {
    const run = store.beginRun(
      a.owner,
      thread.id,
      `complete-${i}`,
      "Synthetic question",
    );
    store.completeRun(a.owner, run.id, "Synthetic answer");
  }
  const failed = store.beginRun(
    a.owner,
    thread.id,
    "failed-at-limit",
    "Synthetic failure",
  );
  store.failRun(a.owner, failed.id);
  expect(store.thread(a.owner, thread.id).messages).toHaveLength(99);
  expect(() =>
    store.beginRun(a.owner, thread.id, "over-limit", "One more"),
  ).toThrow("budget");
  expect(store.thread(a.owner, thread.id).messages).toHaveLength(99);
});

test("memory needs explicit review, is scoped, and supports deletion", () => {
  const { store, a, b } = world();
  expect(() => store.saveMemory(a.owner, "Preference", false)).toThrow(
    "review",
  );
  const memory = store.saveMemory(a.owner, "Preference", true);
  expect(() => store.deleteMemory(b.owner, memory.id)).toThrow("not found");
  store.deleteMemory(a.owner, memory.id);
  expect(store.memories(a.owner)).toEqual([]);
});

test("selected model survives reopen and cannot change under the same request ID", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "model-choice",
    "Hello",
    "openrouter:synthetic:free",
  );
  store.completeRun(a.owner, run.id, "Synthetic reply");
  expect(() =>
    store.beginRun(
      a.owner,
      thread.id,
      "model-choice",
      "Hello",
      "meta:muse-spark-1.3",
    ),
  ).toThrow("conflicts");
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.run(a.owner, run.id).model).toBe("openrouter:synthetic:free");
  expect(reopened.thread(a.owner, thread.id).lastRun?.model).toBe(
    "openrouter:synthetic:free",
  );
});

test("v1 migration preserves historical messages and leaves their model unknown", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "old-client",
    "Historic synthetic message",
  );
  store.completeRun(a.owner, run.id, "Historic synthetic answer");
  store.close();
  const old = new Database(path);
  try {
    old.exec(
      "ALTER TABLE runs DROP COLUMN model; UPDATE version SET value=1 WHERE id=1",
    );
  } finally {
    old.close();
  }
  const upgraded = new SelfHostedStore(path);
  stores.push(upgraded);
  expect(upgraded.thread(a.owner, thread.id).messages).toHaveLength(2);
  expect(upgraded.run(a.owner, run.id).model).toBeNull();
  expect(
    upgraded.beginRun(
      a.owner,
      thread.id,
      "old-client",
      "Historic synthetic message",
    ).fresh,
  ).toBe(false);
});

test("a second server cannot interrupt or steal the first server's pending run", () => {
  const { store, a, path } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(a.owner, thread.id, "pending", "Hello");
  expect(() => new SelfHostedStore(path)).toThrow("cannot be locked");
  expect(store.run(a.owner, run.id).state).toBe("running");
});

test("kernel lock releases after a killed process; pending work is recovered without replay", async () => {
  const folder = mkdtempSync(join(tmpdir(), "saathi-crash-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fixtures/self-hosted-crash.ts"),
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const line = await reader.read();
    reader.releaseLock();
    const ids = JSON.parse(new TextDecoder().decode(line.value));
    expect(() => new SelfHostedStore(path)).toThrow("cannot be locked");
    child.kill();
    await child.exited;
    const recovered = new SelfHostedStore(path);
    stores.push(recovered);
    expect(recovered.run(ids.owner, ids.run).state).toBe("interrupted");
    expect(
      recovered.beginRun(
        ids.owner,
        ids.thread,
        "pending",
        "Synthetic crash test",
      ).fresh,
    ).toBe(false);
    expect(recovered.thread(ids.owner, ids.thread).messages).toHaveLength(1);
  } finally {
    child.kill();
    await child.exited;
  }
}, 15000);
