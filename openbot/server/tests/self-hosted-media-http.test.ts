import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { FixtureSttCoordinator } from "../src/self-hosted/stt-coordinator";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function world(enabled = true, publicOrigin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-media-http-")),
    path = join(dir, "state.sqlite");
  let now = Date.now(),
    calls = 0;
  const store = new SelfHostedStore(path, { now: () => now }),
    roles = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles;
  const db = new Database(path);
  cleanup.push(() => {
    db.close();
    store.close();
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-media-http-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createSelfHostedApp({
    store,
    answer: async () => {
      calls++;
      throw new Error("No inference expected");
    },
    model: "synthetic:free",
    roles,
    publicOrigin,
    localMediaControls: enabled,
  });
  const base = publicOrigin
    ? publicOrigin.replace("https:", "http:")
    : "http://localhost:8790";
  async function session() {
    const start = await app.request(`${base}/api/session`, {
      method: "POST",
      headers: {
        origin: publicOrigin ?? base,
        "content-type": "application/json",
      },
      body: JSON.stringify({ consent: true }),
    });
    const parsed = await start.json(),
      cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const owner = store.session(cookie.slice(cookie.indexOf("=") + 1))!.owner;
    const headers = {
      Cookie: cookie,
      Origin: publicOrigin ?? base,
      "Content-Type": "application/json",
      "X-Saathi-CSRF": parsed.csrf,
    };
    const request = (
      route: string,
      body?: unknown,
      method = "POST",
      extra: Record<string, string> = {},
    ) =>
      app.request(`${base}${route}`, {
        method: body === undefined ? "GET" : method,
        headers: { ...headers, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { owner, headers, request };
  }
  const a = await session(),
    b = await session();
  const admit = (request_id = "clip") =>
    store.media.admit(a.owner, {
      request_id,
      audio: syntheticSpeechFixture("en-IN").audio,
      mimeType: "audio/wav",
      consentToStore: true,
      consentToProcess: true,
      languageHint: "en-IN",
    });
  const media = admit();
  return {
    app,
    base,
    store,
    db,
    a,
    b,
    roles,
    media,
    admit,
    calls: () => calls,
    clock: (value: number) => {
      now = value;
    },
  };
}

test("local media opt-in is literal, off by default and rejected in public configuration", () => {
  expect(selfHostedConfig({}).localMediaControls).toBe(false);
  expect(
    selfHostedConfig({ SAATHI_LOCAL_MEDIA_CONTROLS: "true" })
      .localMediaControls,
  ).toBe(true);
  expect(() =>
    selfHostedConfig({ SAATHI_LOCAL_MEDIA_CONTROLS: "yes" }),
  ).toThrow();
  expect(() =>
    selfHostedConfig({
      SAATHI_LOCAL_MEDIA_CONTROLS: "true",
      SAATHI_PUBLIC_ORIGIN: "https://saathi.example.test",
    }),
  ).toThrow("local media controls");
});
test("disabled and public app modes register no media routes, even under explicit programmatic opt-in", async () => {
  for (const [enabled, publicOrigin] of [
    [false, undefined],
    [true, "https://saathi.example.test"],
  ] as const) {
    const w = await world(enabled, publicOrigin),
      url = `/api/media/${w.media.id}`;
    expect((await w.a.request(url)).status).toBe(404);
    expect((await w.a.request(`${url}/revoke-processing`, {})).status).toBe(
      404,
    );
    expect((await w.a.request(url, {}, "DELETE")).status).toBe(404);
    expect(
      (await (await w.app.request(`${w.base}/health`)).json())
        .local_media_controls,
    ).toBe(false);
    expect(w.store.media.metadata(w.a.owner, w.media.id).consentRevision).toBe(
      1,
    );
    if (!enabled) {
      const omitted = createSelfHostedApp({
        store: w.store,
        answer: async () => "unused",
        model: "synthetic:free",
      });
      expect(
        (await omitted.request(`${w.base}${url}`, { headers: w.a.headers }))
          .status,
      ).toBe(404);
      expect(
        (await (await omitted.request(`${w.base}/health`)).json())
          .local_media_controls,
      ).toBe(false);
    }
  }
});
test("local metadata is owner-only, byte/token/hash-free and distinct from speech capability", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  expect((await w.app.request(`${w.base}${url}`)).status).toBe(401);
  const result = await w.a.request(url);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await result.json();
  expect(body).toEqual(w.media);
  expect(JSON.stringify(body)).not.toMatch(
    /"audio"|executorToken|claim_hash|content_hash|"owner"|transcript/,
  );
  expect((await w.b.request(url)).status).toBe(404);
  const health = await (await w.app.request(`${w.base}/health`)).json();
  expect(health.local_media_controls).toBe(true);
  expect(health.speech).toBe(false);
  expect(health.actions).toBe(false);
  expect(w.calls()).toBe(0);
});
test("same-origin CSRF and strict fields gate every media mutation without changing consent", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  for (const method of ["POST", "DELETE"]) {
    const route = method === "POST" ? `${url}/revoke-processing` : url;
    expect((await w.b.request(route, {}, method)).status).toBe(404);
    expect(
      (await w.a.request(route, {}, method, { "X-Saathi-CSRF": "wrong" }))
        .status,
    ).toBe(403);
    expect(
      (
        await w.a.request(route, {}, method, {
          Origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    for (const body of [
      { owner: w.a.owner },
      { consentToProcess: true },
      { audio: [1] },
      { executorToken: "fake" },
      null,
      [],
    ])
      expect((await w.a.request(route, body, method)).status).toBe(422);
    expect(
      (await w.a.request(`${route}?owner=${w.a.owner}`, {}, method)).status,
    ).toBe(422);
  }
  expect((await w.a.request(`${url}?owner=${w.b.owner}`)).status).toBe(422);
  expect((await w.a.request("/api/media/not-a-uuid")).status).toBe(422);
  expect(
    (await w.a.request("/api/media/00000000-0000-4000-8000-000000000000"))
      .status,
  ).toBe(404);
  expect(
    (await w.a.request(`/api/media/not-a-uuid/revoke-processing`, {})).status,
  ).toBe(422);
  expect(w.store.media.metadata(w.a.owner, w.media.id)).toEqual(w.media);
  expect(w.calls()).toBe(0);
});
test("revoke and delete are repeat-safe and atomically clear retained fixture output without a model/live provider call", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  const admission = w.store.sttAdmissions.begin(
    w.a.owner,
    { request_id: "stt", media_id: w.media.id, consent_revision: 1 },
    w.roles.stt,
  );
  const runner = new FixtureSttCoordinator(
    w.store.sttAdmissions,
    () => w.roles,
  );
  expect((await runner.run(w.a.owner, admission.id)).state).toBe("completed");
  await runner.drain();
  const revoked = await (
    await w.a.request(`${url}/revoke-processing`, {})
  ).json();
  expect(revoked.consentToProcess).toBe(false);
  expect(revoked.consentRevision).toBe(2);
  expect(revoked.state).toBe("active");
  expect(
    await (await w.a.request(`${url}/revoke-processing`, {})).json(),
  ).toEqual(revoked);
  expect(w.store.sttAdmissions.get(w.a.owner, admission.id).outcome).toBeNull();
  expect(
    w.db
      .query<{ outcome: string | null }, [string]>(
        "SELECT outcome FROM stt_admissions WHERE id=?",
      )
      .get(admission.id)?.outcome,
  ).toBeNull();
  const removed = await (await w.a.request(url, {}, "DELETE")).json();
  expect(removed.state).toBe("deleted");
  expect(removed.consentToStore).toBe(false);
  expect(removed.consentRevision).toBe(3);
  expect(await (await w.a.request(url, {}, "DELETE")).json()).toEqual(removed);
  expect(
    await (await w.a.request(`${url}/revoke-processing`, {})).json(),
  ).toEqual(removed);
  expect(await (await w.a.request(url)).json()).toEqual(removed);
  expect(
    w.db
      .query<{ audio: Uint8Array | null }, [string]>(
        "SELECT audio FROM owned_media WHERE id=?",
      )
      .get(w.media.id)?.audio,
  ).toBeNull();
  expect(w.calls()).toBe(0);
});
test("metadata expiry does not promise physical cleanup and expired sessions cannot read or mutate", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  w.clock(w.media.expiresAt);
  expect((await (await w.a.request(url)).json()).state).toBe("expired");
  expect(
    w.db
      .query<{ n: number }, [string]>(
        "SELECT length(audio) n FROM owned_media WHERE id=?",
      )
      .get(w.media.id)?.n,
  ).toBe(w.media.byteLength);
  expect((await w.a.request(url, {}, "DELETE")).status).toBe(200);
  w.clock(Date.now() + 86400001);
  // HTTP sessions use the real clock; expire their authoritative rows as well.
  w.db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(w.a.owner);
  for (const response of [
    await w.a.request(url),
    await w.a.request(url, {}, "DELETE"),
    await w.a.request(`${url}/revoke-processing`, {}),
  ])
    expect(response.status).toBe(401);
  expect(w.calls()).toBe(0);
});
test("media controls preserve the global JSON60KB limit and expose no audio or execution route", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  expect(
    (
      await w.app.request(`${w.base}${url}/revoke-processing`, {
        method: "POST",
        headers: w.a.headers,
        body: JSON.stringify({ extra: "x".repeat(60000) }),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await w.app.request(`${w.base}${url}`, {
        method: "DELETE",
        headers: w.a.headers,
        body: "{",
      })
    ).status,
  ).toBe(400);
  for (const suffix of [
    "/audio",
    "/history",
    "/transcribe",
    "/claim",
    "/settle",
  ])
    expect((await w.a.request(url + suffix)).status).toBe(404);
  expect((await w.a.request("/api/media", {})).status).toBe(404);
  expect(w.store.media.metadata(w.a.owner, w.media.id)).toEqual(w.media);
  expect(w.calls()).toBe(0);
});

test("HTTP revoke/delete preserve a handed-out worker slot until private acknowledgement", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  const admission = w.store.sttAdmissions.begin(
    w.a.owner,
    { request_id: "held", media_id: w.media.id, consent_revision: 1 },
    w.roles.stt,
  );
  const claim = w.store.sttAdmissions.claim(
    w.a.owner,
    admission.id,
    w.roles.stt,
  );
  if (!claim.fresh) throw new Error("Expected private fixture claim");
  for (const response of [
    await w.a.request(`${url}/revoke-processing`, {}),
    await w.a.request(url, {}, "DELETE"),
  ]) {
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(claim.executorToken);
  }
  const pending = w.store.sttAdmissions.get(w.a.owner, admission.id);
  expect(pending.state).toBe("revoked");
  expect(pending.pending).toBe(true);
  expect(pending.outcome).toBeNull();
  expect(
    w.store.sttAdmissions.settle(w.a.owner, admission.id, claim.executorToken, {
      status: "failed",
      code: "aborted",
    }).pending,
  ).toBe(false);
  expect(w.calls()).toBe(0);
});

test("failed consent-history writes return a sanitized503 and roll back HTTP media mutations", async () => {
  const w = await world(),
    url = `/api/media/${w.media.id}`;
  w.db.exec(
    "CREATE TRIGGER fail_media_history BEFORE INSERT ON media_consent_events BEGIN SELECT RAISE(ABORT,'private storage detail'); END",
  );
  for (const response of [
    await w.a.request(`${url}/revoke-processing`, {}),
    await w.a.request(url, {}, "DELETE"),
  ]) {
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private storage detail");
    expect(w.store.media.metadata(w.a.owner, w.media.id)).toEqual(w.media);
    expect(w.store.media.read(w.a.owner, w.media.id)).toEqual(
      syntheticSpeechFixture("en-IN").audio,
    );
  }
});
