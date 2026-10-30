import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import type {
  SpeechToTextProvider,
  Transcript,
} from "../src/self-hosted/speech";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { FixtureSttCoordinator } from "../src/self-hosted/stt-coordinator";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  checks: Database[] = [];
afterEach(() => {
  for (const db of checks.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-coordinator-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(folder, { recursive: true, force: true });
  }
});
function world(
  locale: "en-IN" | "hi-IN" | "ta-IN" = "en-IN",
  provider = "fixture-a",
) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-coordinator-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite"),
    store = new SelfHostedStore(path);
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession(),
    fixture = syntheticSpeechFixture(locale);
  let roles = selfHostedConfig({
    SAATHI_STT_PROVIDER: provider,
    SAATHI_STT_TIMEOUT_MS: "1000",
  }).roles;
  const media = store.media.admit(a.owner, {
    request_id: "clip",
    audio: fixture.audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: locale,
  });
  const admission = store.sttAdmissions.begin(
    a.owner,
    {
      request_id: "stt",
      media_id: media.id,
      consent_revision: media.consentRevision,
    },
    roles.stt,
  );
  const status = () => store.sttAdmissions.get(a.owner, admission.id);
  const transcript: Transcript = {
    text: fixture.text,
    language: locale,
    confidence: null,
    alternatives: [],
    warnings: [],
    source: { mode: "fixture", provider, model: "synthetic-stt-v1" },
  };
  return {
    store,
    path,
    a,
    b,
    media,
    admission,
    fixture,
    transcript,
    status,
    roles: () => roles,
    disable: () => {
      roles = selfHostedConfig({}).roles;
    },
  };
}
function held(w: ReturnType<typeof world>, now?: () => number) {
  let calls = 0,
    signal: AbortSignal | undefined;
  let release!: (value: Transcript) => void, reject!: (error: Error) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const result = new Promise<Transcript>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  const adapter: SpeechToTextProvider = {
    transcribe: (input) => {
      calls++;
      signal = input.signal;
      started();
      return result;
    },
  };
  const runner = new FixtureSttCoordinator(w.store.sttAdmissions, w.roles, {
    fixtureProvider: () => adapter,
    now,
  });
  return {
    runner,
    ready,
    release,
    reject,
    calls: () => calls,
    signal: () => signal,
  };
}

test("owned fixture coordinator completes both providers and en/hi/ta without replaying duplicates", async () => {
  for (const locale of ["en-IN", "hi-IN", "ta-IN"] as const)
    for (const provider of ["fixture-a", "fixture-b"]) {
      const w = world(locale, provider),
        runner = new FixtureSttCoordinator(w.store.sttAdmissions, w.roles);
      const first = await runner.run(w.a.owner, w.admission.id);
      expect(first.state).toBe("completed");
      expect(first.pending).toBe(false);
      expect(first.outcome?.status).toBe("completed");
      if (first.outcome?.status !== "completed")
        throw new Error("Expected fixture completion");
      expect(first.outcome.transcript.text).toBe(w.fixture.text);
      expect(first.outcome.transcript.source).toEqual({
        mode: "fixture",
        provider,
        model: "synthetic-stt-v1",
      });
      expect(JSON.stringify(first)).not.toMatch(
        /executorToken|claim_hash|"audio"/,
      );
      expect(await runner.run(w.a.owner, w.admission.id)).toEqual(first);
      await expect(runner.run(w.b.owner, w.admission.id)).rejects.toMatchObject(
        { status: 404 },
      );
      await runner.drain();
    }
});
test("cancel signals once and keeps an abort-ignoring worker pending until actual acknowledgement", async () => {
  const w = world(),
    h = held(w),
    running = h.runner.run(w.a.owner, w.admission.id);
  await h.ready;
  expect((await h.runner.run(w.a.owner, w.admission.id)).state).toBe("claimed");
  await expect(
    Promise.resolve().then(() => h.runner.cancel(w.b.owner, w.admission.id)),
  ).rejects.toMatchObject({ status: 404 });
  expect(h.signal()?.aborted).toBe(false);
  expect(h.runner.cancel(w.a.owner, w.admission.id).pending).toBe(true);
  expect(h.signal()?.aborted).toBe(true);
  const stopped = await running;
  expect(stopped.state).toBe("cancelled");
  expect(stopped.pending).toBe(true);
  expect(h.calls()).toBe(1);
  h.release(w.transcript);
  await h.runner.drain();
  expect(w.status().state).toBe("cancelled");
  expect(w.status().pending).toBe(false);
  expect(w.status().outcome).toBeNull();
  await h.runner.run(w.a.owner, w.admission.id);
  expect(h.calls()).toBe(1);
});
test("deadline abort is bounded but an ignored abort cannot free a worker slot early", async () => {
  const w = world(),
    h = held(w, () => Date.now() - 60000),
    running = h.runner.run(w.a.owner, w.admission.id);
  await h.ready;
  const stopped = await running;
  expect(h.signal()?.aborted).toBe(true);
  expect(stopped.pending).toBe(true);
  expect(stopped.outcome).toBeNull();
  h.release(w.transcript);
  await h.runner.drain();
  expect(w.status().state).toBe("failed");
  expect(w.status().failureCode).toBe("timeout");
  expect(w.status().outcome).toEqual({ status: "failed", code: "timeout" });
});
test("parent abort before claim invokes nothing; abort during work retains slot until late rejection", async () => {
  const before = world(),
    a = held(before),
    pre = new AbortController();
  pre.abort();
  expect(
    (await a.runner.run(before.a.owner, before.admission.id, pre.signal)).state,
  ).toBe("cancelled");
  expect(a.calls()).toBe(0);
  const w = world(),
    h = held(w),
    parent = new AbortController(),
    running = h.runner.run(w.a.owner, w.admission.id, parent.signal);
  await h.ready;
  parent.abort();
  expect((await running).pending).toBe(true);
  expect(h.signal()?.aborted).toBe(true);
  h.reject(new Error("private provider text"));
  await h.runner.drain();
  expect(w.status().outcome).toEqual({ status: "failed", code: "aborted" });
  expect(w.status().pending).toBe(false);
});
test("revoked late text stays suppressed and changed server policy cannot invoke a fixture", async () => {
  const w = world(),
    h = held(w),
    running = h.runner.run(w.a.owner, w.admission.id);
  await h.ready;
  w.store.media.revokeProcessing(w.a.owner, w.media.id);
  h.release(w.transcript);
  expect((await running).state).toBe("revoked");
  await h.runner.drain();
  expect(w.status().outcome).toBeNull();
  expect(w.status().pending).toBe(false);
  const changed = world(),
    blocked = held(changed);
  changed.disable();
  expect(
    (await blocked.runner.run(changed.a.owner, changed.admission.id)).state,
  ).toBe("blocked");
  expect(blocked.calls()).toBe(0);
});
test("throwing or forged fixture output becomes a fixed failure without raw error or transcript retention", async () => {
  for (const mode of ["throw", "forged", "oversized"] as const) {
    const w = world(),
      runner = new FixtureSttCoordinator(w.store.sttAdmissions, w.roles, {
        fixtureProvider: () => ({
          transcribe: async () => {
            if (mode === "throw") throw new Error("private upstream error");
            if (mode === "oversized")
              return {
                ...w.transcript,
                text: "\0".repeat(2000),
                warnings: Array(8).fill("\0".repeat(300)),
              };
            return { ...w.transcript, confidence: 1 };
          },
        }),
      });
    const result = await runner.run(w.a.owner, w.admission.id);
    expect(result.state).toBe("failed");
    expect(result.pending).toBe(false);
    expect(result.outcome).toEqual({
      status: "failed",
      code: "provider_failed",
    });
    expect(JSON.stringify(result)).not.toContain("private upstream");
  }
});
test("background acknowledgement errors are surfaced to trusted drain without unhandled raw failures", async () => {
  const w = world(),
    h = held(w),
    running = h.runner.run(w.a.owner, w.admission.id);
  await h.ready;
  h.runner.cancel(w.a.owner, w.admission.id);
  await running;
  const db = new Database(w.path);
  checks.push(db);
  db.exec(
    "CREATE TRIGGER fail_ack BEFORE UPDATE OF settled_at ON stt_admissions BEGIN SELECT RAISE(ABORT,'private storage detail'); END",
  );
  h.release(w.transcript);
  await expect(h.runner.drain()).rejects.toThrow(
    "Fixture acknowledgement failed; exclusive recovery is required.",
  );
  expect(w.status().pending).toBe(true);
  expect(w.status().outcome).toBeNull();
  await expect(h.runner.run(w.a.owner, w.admission.id)).rejects.toThrow(
    "Fixture acknowledgement failed; exclusive recovery is required.",
  );
});

test("immediate durable cancellation before the queued invocation sends no audio to the adapter", async () => {
  const w = world(),
    h = held(w),
    running = h.runner.run(w.a.owner, w.admission.id);
  h.runner.cancel(w.a.owner, w.admission.id);
  const result = await running;
  expect(result.state).toBe("cancelled");
  expect(result.pending).toBe(false);
  expect(result.outcome).toBeNull();
  expect(h.calls()).toBe(0);
  await h.runner.drain();
});

test("expired owner cannot read a bounded response but the worker can still acknowledge without retaining text", async () => {
  const w = world(),
    h = held(w),
    parent = new AbortController();
  const running = h.runner.run(w.a.owner, w.admission.id, parent.signal);
  await h.ready;
  const db = new Database(w.path);
  checks.push(db);
  db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(w.a.owner);
  parent.abort();
  await expect(running).rejects.toMatchObject({ status: 403 });
  const row = () =>
    db
      .query<{ pending: number; outcome: string | null }, [string]>(
        "SELECT pending,outcome FROM stt_admissions WHERE id=?",
      )
      .get(w.admission.id);
  expect(row()?.pending).toBe(1);
  h.release(w.transcript);
  await h.runner.drain();
  expect(row()?.pending).toBe(0);
  expect(row()?.outcome).toBeNull();
  expect(() => w.status()).toThrow("active owner session");
});
