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

test("terminal coordinator stop refuses runs before role lookup or audio claim and does not refund reservations", async () => {
  const w = world();
  const runner = new FixtureSttCoordinator(w.store.sttAdmissions, () => {
    throw new Error("Role lookup must not run after stop");
  });
  expect(runner.stop()).toEqual({
    stopping: true,
    pendingWorkers: 0,
    acknowledgementFailed: false,
  });
  expect(runner.stop()).toEqual({
    stopping: true,
    pendingWorkers: 0,
    acknowledgementFailed: false,
  });
  await expect(runner.run(w.a.owner, w.admission.id)).rejects.toMatchObject({
    status: 503,
  });
  expect(w.status().state).toBe("reserved");
  expect(w.status().claimedAt).toBeNull();
  expect(w.status().pending).toBe(true);
  const db = new Database(w.path);
  checks.push(db);
  expect(
    db
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(1);
  await runner.drain();
});

test("shutdown initiated by a dynamic role lookup still denies the private claim", async () => {
  const w = world();
  let runner: FixtureSttCoordinator,
    calls = 0;
  runner = new FixtureSttCoordinator(
    w.store.sttAdmissions,
    () => {
      runner.stop();
      return w.roles();
    },
    {
      fixtureProvider: () => {
        calls++;
        throw new Error("No handoff permitted");
      },
    },
  );
  await expect(runner.run(w.a.owner, w.admission.id)).rejects.toThrow(
    "stopping",
  );
  expect(w.status().state).toBe("reserved");
  expect(w.status().claimedAt).toBeNull();
  expect(calls).toBe(0);
});

test("stop signals once but drain waits for an abort-ignoring worker's real success or rejection", async () => {
  for (const failure of [false, true]) {
    const w = world(),
      h = held(w),
      running = h.runner.run(w.a.owner, w.admission.id);
    await h.ready;
    let aborts = 0;
    h.signal()?.addEventListener("abort", () => {
      aborts++;
    });
    expect(h.runner.stop()).toEqual({
      stopping: true,
      pendingWorkers: 1,
      acknowledgementFailed: false,
    });
    expect(h.runner.stop().pendingWorkers).toBe(1);
    expect(aborts).toBe(1);
    expect((await running).pending).toBe(true);
    let drained = false;
    const draining = h.runner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(w.status().outcome).toBeNull();
    expect(w.status().pending).toBe(true);
    if (failure) h.reject(new Error("private late error"));
    else h.release(w.transcript);
    await draining;
    expect(w.status().pending).toBe(false);
    expect(w.status().outcome).toEqual({ status: "failed", code: "aborted" });
    expect(h.runner.stop().pendingWorkers).toBe(0);
    await expect(h.runner.run(w.a.owner, w.admission.id)).rejects.toThrow(
      "stopping",
    );
    expect(h.calls()).toBe(1);
  }
});

test("stop between claim and queued adapter invocation releases only the unhanded worker after acknowledgement", async () => {
  const w = world(),
    h = held(w),
    running = h.runner.run(w.a.owner, w.admission.id);
  expect(h.runner.stop().pendingWorkers).toBe(1);
  const result = await running;
  await h.runner.drain();
  expect(result.pending).toBe(false);
  expect(result.outcome).toEqual({ status: "failed", code: "aborted" });
  expect(h.calls()).toBe(0);
  expect(h.runner.stop().pendingWorkers).toBe(0);
});

test("stopping after completed work preserves saved evidence while disabling further execution", async () => {
  const w = world(),
    runner = new FixtureSttCoordinator(w.store.sttAdmissions, w.roles);
  const saved = await runner.run(w.a.owner, w.admission.id);
  expect(saved.state).toBe("completed");
  expect(runner.stop().pendingWorkers).toBe(0);
  await runner.drain();
  expect(w.status()).toEqual(saved);
  await expect(runner.run(w.a.owner, w.admission.id)).rejects.toThrow(
    "stopping",
  );
});

test("stop during validation of an already fulfilled adapter result suppresses completion at settlement", async () => {
  const w = world();
  let runner: FixtureSttCoordinator;
  runner = new FixtureSttCoordinator(w.store.sttAdmissions, w.roles, {
    fixtureProvider: () => ({
      transcribe: async () => ({
        ...w.transcript,
        get text() {
          runner.stop();
          return w.transcript.text;
        },
      }),
    }),
  });
  const result = await runner.run(w.a.owner, w.admission.id);
  expect(result.state).toBe("failed");
  expect(result.outcome).toEqual({ status: "failed", code: "aborted" });
  expect(result.pending).toBe(false);
  await runner.drain();
});

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
  expect(h.runner.stop()).toEqual({
    stopping: true,
    pendingWorkers: 0,
    acknowledgementFailed: true,
  });
  await expect(h.runner.run(w.a.owner, w.admission.id)).rejects.toThrow(
    "Fixture acknowledgement failed; exclusive recovery is required.",
  );
});

test("a stopped abort-ignoring process keeps the kernel/worker slot until process loss, then recovery never replays", async () => {
  const folder = mkdtempSync(join(tmpdir(), "saathi-coordinator-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "fixtures/self-hosted-stt-stopped-worker.ts"),
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let output = "";
    try {
      await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          while (!output.includes("\n")) {
            const part = await reader.read();
            if (part.done)
              throw new Error("Synthetic worker did not report ready");
            output += decoder.decode(part.value, { stream: true });
            if (output.length > 4096)
              throw new Error("Synthetic worker output too large");
          }
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Synthetic worker startup timed out")),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      reader.releaseLock();
    }
    const observed = JSON.parse(output) as {
      owner: string;
      id: string;
      pending: boolean;
      state: string;
      aborts: number;
      workers: number;
    };
    expect(observed.state).toBe("claimed");
    expect(observed.pending).toBe(true);
    expect(observed.aborts).toBe(1);
    expect(observed.workers).toBe(1);
    expect(output).not.toMatch(/executorToken|claim_hash|"audio"/);
    expect(() => new SelfHostedStore(path)).toThrow("cannot be locked");
    child.kill();
    await child.exited;
    const recovered = new SelfHostedStore(path);
    stores.push(recovered);
    const status = recovered.sttAdmissions.get(observed.owner, observed.id);
    expect(status.state).toBe("interrupted");
    expect(status.pending).toBe(false);
    expect(status.outcome).toBeNull();
    let calls = 0;
    const runner = new FixtureSttCoordinator(
      recovered.sttAdmissions,
      () => selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles,
      {
        fixtureProvider: () => {
          calls++;
          throw new Error("No replay permitted");
        },
      },
    );
    expect((await runner.run(observed.owner, observed.id)).state).toBe(
      "interrupted",
    );
    expect(calls).toBe(0);
    const db = new Database(path);
    checks.push(db);
    expect(
      db
        .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
        .get()?.n,
    ).toBe(1);
  } finally {
    child.kill();
    await child.exited;
  }
}, 15000);

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
