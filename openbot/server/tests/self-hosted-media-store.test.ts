import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { MediaLimits } from "../src/self-hosted/media-store";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  databases: Database[] = [];
const inspect = (path: string) => {
  const db = new Database(path);
  databases.push(db);
  return db;
};
const input = (request_id = "clip") => ({
  request_id,
  audio: syntheticSpeechFixture("en-IN").audio,
  mimeType: "audio/wav",
  consentToStore: true,
  consentToProcess: true,
  languageHint: "en-IN",
});
function world(mediaLimits?: Partial<MediaLimits>) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-media-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  let now = Date.now();
  const open = () => {
    const store = new SelfHostedStore(path, { now: () => now, mediaLimits });
    stores.push(store);
    return store;
  };
  const store = open();
  return {
    path,
    store,
    open,
    a: store.createSession(),
    b: store.createSession(),
    now: () => now,
    clock: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-media-")
    )
      throw new Error("Unsafe cleanup target");
    rmSync(folder, { recursive: true, force: true });
  }
});

test("owned media survives reopen; exact duplicates preserve identity/expiry and changed input conflicts", () => {
  const w = world(),
    request = input();
  const saved = w.store.media.admit(w.a.owner, request);
  expect(saved.state).toBe("active");
  expect(saved.byteLength).toBe(8044);
  expect(saved.consentToProcess).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('"audio"');
  expect(() => w.store.media.read(w.b.owner, saved.id)).toThrow("not found");
  expect(() => w.store.media.metadata(w.b.owner, saved.id)).toThrow(
    "not found",
  );
  expect(() => w.store.media.remove(w.b.owner, saved.id)).toThrow("not found");
  const first = w.store.media.read(w.a.owner, saved.id);
  first[0] = 0;
  expect(w.store.media.read(w.a.owner, saved.id)[0]).toBe(82);
  request.audio[0] = 0;
  expect(w.store.media.read(w.a.owner, saved.id)[0]).toBe(82);
  w.clock(w.now() + 1000);
  expect(w.store.media.admit(w.a.owner, input())).toEqual(saved);
  expect(() =>
    w.store.media.admit(w.a.owner, { ...input(), consentToProcess: false }),
  ).toThrow("conflicts");
  expect(() =>
    w.store.media.admit(w.a.owner, { ...input(), languageHint: "ta-IN" }),
  ).toThrow("conflicts");
  w.store.close();
  const reopened = w.open();
  expect(reopened.media.metadata(w.a.owner, saved.id)).toEqual(saved);
  expect(reopened.media.read(w.a.owner, saved.id)).toEqual(input().audio);
});

test("expiry denies new reads without silently reclaiming quota; explicit cleanup clears blobs and never revives duplicates", () => {
  const w = world({ ownerClips: 1 }),
    saved = w.store.media.admit(w.a.owner, input());
  w.clock(saved.expiresAt);
  expect(w.store.media.metadata(w.a.owner, saved.id).state).toBe("expired");
  expect(() => w.store.media.read(w.a.owner, saved.id)).toThrow("unavailable");
  expect(() => w.store.media.admit(w.a.owner, input("second"))).toThrow(
    "budget",
  );
  expect(w.store.media.purgeExpired()).toBe(1);
  expect(w.store.media.purgeExpired()).toBe(0);
  const old = w.store.media.admit(w.a.owner, input());
  expect(old.id).toBe(saved.id);
  expect(old.state).toBe("expired");
  expect(old.expiresAt).toBe(saved.expiresAt);
  expect(w.store.media.admit(w.a.owner, input("second")).state).toBe("active");
});

test("processing revocation is durable; deletion/storage revocation atomically clear active blobs and cannot be replayed into consent", () => {
  const w = world(),
    first = w.store.media.admit(w.a.owner, input());
  expect(
    w.store.media.revokeProcessing(w.a.owner, first.id).consentToProcess,
  ).toBe(false);
  expect(w.store.media.admit(w.a.owner, input()).consentToProcess).toBe(false);
  expect(w.store.media.read(w.a.owner, first.id)).toEqual(input().audio);
  const revoked = w.store.media.revoke(w.a.owner, first.id);
  expect(revoked.state).toBe("revoked");
  expect(revoked.consentToStore).toBe(false);
  expect(w.store.media.remove(w.a.owner, first.id)).toEqual(revoked);
  expect(w.store.media.admit(w.a.owner, input()).state).toBe("revoked");
  expect(() => w.store.media.read(w.a.owner, first.id)).toThrow("unavailable");
  const second = w.store.media.admit(w.a.owner, input("second"));
  const deleted = w.store.media.remove(w.a.owner, second.id);
  expect(deleted.state).toBe("deleted");
  expect(w.store.media.remove(w.a.owner, second.id)).toEqual(deleted);
  const check = inspect(w.path);
  expect(
    check
      .query<{ n: number }, []>(
        "SELECT count(*) n FROM owned_media WHERE audio IS NOT NULL",
      )
      .get()?.n,
  ).toBe(0);
  w.store.close();
  expect(w.open().media.admit(w.a.owner, input()).state).toBe("revoked");
});

test("owner/global bytes and lifetime tombstones remain bounded; invalid input creates no row", () => {
  const w = world({ ownerBytes: 8044, globalBytes: 16088, ownerRecords: 2 });
  const first = w.store.media.admit(w.a.owner, input());
  expect(() => w.store.media.admit(w.a.owner, input("second"))).toThrow(
    "budget",
  );
  w.store.media.admit(w.b.owner, input());
  const third = w.store.createSession();
  expect(() => w.store.media.admit(third.owner, input())).toThrow("budget");
  w.store.media.remove(w.a.owner, first.id);
  const second = w.store.media.admit(w.a.owner, input("second"));
  w.store.media.remove(w.a.owner, second.id);
  expect(() => w.store.media.admit(w.a.owner, input("third"))).toThrow(
    "budget",
  );
  expect(() =>
    w.store.media.admit(third.owner, { ...input(), consentToStore: false }),
  ).toThrow();
  const check = inspect(w.path);
  expect(
    check.query<{ n: number }, []>("SELECT count(*) n FROM owned_media").get()
      ?.n,
  ).toBe(3);
});

test("session expiry clamps retention and corrupt media is never returned", () => {
  const w = world(),
    check = inspect(w.path);
  check
    .query("UPDATE sessions SET expires=? WHERE owner=?")
    .run(w.now() + 1000, w.a.owner);
  const saved = w.store.media.admit(w.a.owner, input());
  expect(saved.expiresAt).toBe(w.now() + 1000);
  check
    .query("UPDATE owned_media SET audio=? WHERE id=?")
    .run(new Uint8Array(8044), saved.id);
  expect(() => w.store.media.read(w.a.owner, saved.id)).toThrow("unavailable");
  w.clock(saved.expiresAt);
  expect(() => w.store.media.admit(w.a.owner, input("later"))).toThrow(
    "session",
  );
});

test("v7-to-v8 migration preserves owned chat/preferences/usage and an approved MOCK receipt", () => {
  const w = world(),
    thread = w.store.createThread(w.a.owner, "saathi");
  const run = w.store.beginRun(
    w.a.owner,
    thread.id,
    "synthetic-chat",
    "Synthetic hello",
  );
  w.store.completeRun(w.a.owner, run.id, "Synthetic reply");
  w.store.saveMemory(w.a.owner, "Synthetic reviewed preference", true);
  const date = new Date(w.now() + 86400000).toISOString().slice(0, 10);
  const task = w.store.appointments.create(w.a.owner, {
    request_id: "demo",
    date,
    locale: "en-IN",
  });
  const quote = w.store.appointments.preview(w.a.owner, task.id, {
    slot_id: "10:00",
    version: task.version,
  });
  const booking = w.store.appointments.decide(w.a.owner, task.id, {
    request_id: "approve",
    decision: "approve",
    version: quote.task.version,
    nonce: quote.nonce,
  });
  w.store.close();
  const fixture = inspect(w.path);
  fixture.exec("DROP TABLE owned_media; UPDATE version SET value=7 WHERE id=1");
  const migrated = w.open();
  expect(migrated.thread(w.a.owner, thread.id).messages).toHaveLength(2);
  expect(migrated.appointments.get(w.a.owner, task.id).receipt).toEqual(
    booking.receipt,
  );
  const check = inspect(w.path);
  expect(
    check.query<{ value: number }, []>("SELECT value FROM version").get()
      ?.value,
  ).toBe(8);
  expect(
    check.query<{ n: number }, []>("SELECT count(*) n FROM memories").get()?.n,
  ).toBe(1);
  expect(
    check
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  expect(migrated.media.admit(w.a.owner, input()).state).toBe("active");
});

test("lifetime global row limits survive deletion and invalid budgets cannot open the store", () => {
  const w = world({ globalRecords: 1 }),
    saved = w.store.media.admit(w.a.owner, input());
  w.store.media.remove(w.a.owner, saved.id);
  expect(() => w.store.media.admit(w.b.owner, input())).toThrow("budget");
  expect(w.store.media.admit(w.a.owner, input()).state).toBe("deleted");
  expect(() => world({ globalBytes: 100_000_001 })).toThrow("budget");
});

test("separate processes serialize competing quota admissions and exact duplicates without duplicate blobs", async () => {
  for (const sameRequest of [false, true]) {
    const w = world(),
      children = ["a", "b"].map((suffix) =>
        Bun.spawn(
          [
            process.execPath,
            resolve(import.meta.dir, "fixtures/self-hosted-media-contender.ts"),
            w.path,
            w.a.owner,
            sameRequest ? "same" : `race-${suffix}`,
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        ),
      );
    try {
      await Promise.all(
        children.map(async (child) => {
          const reader = child.stdout.getReader(),
            first = await reader.read();
          reader.releaseLock();
          expect(new TextDecoder().decode(first.value).trim()).toBe("ready");
        }),
      );
      for (const child of children) {
        child.stdin.write("go\n");
        child.stdin.end();
      }
      const results = await Promise.all(
        children.map(async (child) => {
          const reader = child.stdout.getReader(),
            decoder = new TextDecoder();
          let output = "";
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              output += decoder.decode(next.value, { stream: true });
            }
            output += decoder.decode();
          } finally {
            reader.releaseLock();
          }
          expect(await child.exited).toBe(0);
          return JSON.parse(output) as { status: string; id?: string };
        }),
      );
      expect(results.map((result) => result.status).sort()).toEqual(
        sameRequest ? ["ok", "ok"] : ["ok", "quota"],
      );
      if (sameRequest) expect(results[0]?.id).toBe(results[1]?.id);
      const check = inspect(w.path);
      expect(
        check
          .query<{ n: number }, []>(
            "SELECT count(*) n FROM owned_media WHERE audio IS NOT NULL",
          )
          .get()?.n,
      ).toBe(1);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }
}, 15000);
