import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import { SelfHostedStore } from "../src/self-hosted/store";

const stores: SelfHostedStore[] = [],
  folders: string[] = [];
const roles = selfHostedConfig({}).roles;
const input = {
  request_id: "plan-1",
  goal: "Find demo dental slots",
  locale: "en-IN",
  date: "2026-10-30",
};
function world(limits = { global: 5, owner: 3 }) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-plans-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite"),
    store = new SelfHostedStore(path, { limits });
  stores.push(store);
  return { store, path, a: store.createSession(), b: store.createSession() };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-plans-")
    )
      throw new Error("Unsafe test cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
});
test("planning pins roles, deduplicates request identity, isolates owners and never replays on reopen", () => {
  const { store, path, a, b } = world();
  const task = store.plans.begin(a.owner, input, roles);
  expect(task.fresh).toBe(true);
  expect(task.state).toBe("PLANNING");
  expect(task.roles.revision).toBe(roles.revision);
  const changed = selfHostedConfig({
    SAATHI_REASONING_MODEL: "openrouter:some/model:free",
  }).roles;
  const duplicate = store.plans.begin(a.owner, input, changed);
  expect(duplicate.id).toBe(task.id);
  expect(duplicate.roles.reasoning.id).toBe(roles.reasoning.id);
  expect(duplicate.fresh).toBe(false);
  expect(() =>
    store.plans.begin(a.owner, { ...input, goal: "Changed" }, roles),
  ).toThrow("conflicts");
  expect(() => store.plans.get(b.owner, task.id)).toThrow("not found");
  expect(() => store.plans.cancel(b.owner, task.id)).toThrow("not found");
  expect(store.plans.list(b.owner)).toEqual([]);
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.plans.get(a.owner, task.id).state).toBe("INTERRUPTED");
  expect(reopened.plans.begin(a.owner, input, changed).fresh).toBe(false);
  expect(reopened.plans.get(a.owner, task.id).roles).toEqual(roles);
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(1);
  db.close();
});
test("planner and chat share pending guards and durable attempt allowance; cancellation suppresses late completion", () => {
  const { store, a, path } = world({ global: 3, owner: 2 });
  const thread = store.createThread(a.owner, "saathi");
  const chat = store.beginRun(a.owner, thread.id, "chat-1", "Synthetic chat");
  expect(() => store.plans.begin(a.owner, input, roles)).toThrow("running");
  store.failRun(a.owner, chat.id);
  const task = store.plans.begin(a.owner, input, roles);
  expect(() =>
    store.beginRun(a.owner, thread.id, "chat-2", "Another chat"),
  ).toThrow("running");
  expect(store.plans.cancel(a.owner, task.id).state).toBe("CANCELLED");
  expect(store.plans.cancel(a.owner, task.id).state).toBe("CANCELLED");
  expect(() =>
    store.plans.begin(
      a.owner,
      { ...input, request_id: "while-cancelling" },
      roles,
    ),
  ).toThrow("running");
  store.plans.fail(a.owner, task.id);
  expect(store.plans.get(a.owner, task.id).state).toBe("CANCELLED");
  expect(() =>
    store.plans.begin(a.owner, { ...input, request_id: "plan-2" }, roles),
  ).toThrow("allowance");
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(2);
  db.close();
});
test("v5 upgrade preserves history, preferences, mock bookings and attempt usage", () => {
  const { store, path, a } = world();
  const thread = store.createThread(a.owner, "saathi"),
    run = store.beginRun(a.owner, thread.id, "before", "Synthetic");
  store.completeRun(a.owner, run.id, "Saved answer");
  store.saveMemory(a.owner, "Synthetic preference", true);
  const date = store.appointments.options().max_date;
  const booking = store.appointments.create(a.owner, {
    request_id: "mock",
    date,
    locale: "en-IN",
  });
  store.close();
  const db = new Database(path);
  db.exec(
    "DROP TABLE plan_events; DROP TABLE task_plans; UPDATE version SET value=5",
  );
  db.close();
  const migrated = new SelfHostedStore(path);
  stores.push(migrated);
  expect(migrated.thread(a.owner, thread.id).messages).toHaveLength(2);
  expect(migrated.memories(a.owner)).toHaveLength(1);
  expect(migrated.appointments.get(a.owner, booking.id).date).toBe(date);
  expect(migrated.plans.list(a.owner)).toEqual([]);
  const verify = new Database(path);
  expect(
    verify.query<{ value: number }, []>("SELECT value FROM version").get()
      ?.value,
  ).toBe(6);
  expect(
    verify
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  verify.close();
});
