import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type AnswerInput, createSelfHostedApp } from "../src/self-hosted/app";
import type { ModelCatalog } from "../src/self-hosted/models";
import type { GroundedAnswer } from "../src/self-hosted/search";
import { SelfHostedStore } from "../src/self-hosted/store";
import { attachSelfHostedWeb } from "../src/self-hosted/web";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
async function fixture(
  answer: (input: AnswerInput) => Promise<string | GroundedAnswer> = async (
    input: AnswerInput,
  ) => `Remembered: ${input.memories.join(";") || "nothing"}`,
  models?: () => Promise<ModelCatalog>,
  publicOrigin?: string,
) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-http-"));
  const store = new SelfHostedStore(join(dir, "db.sqlite"));
  cleanups.push(() => {
    store.close();
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-http-")
    )
      throw new Error(
        "Refuse cleanup outside the named test temporary directory.",
      );
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createSelfHostedApp({
    store,
    answer,
    model: "synthetic:free",
    models,
    publicOrigin,
  });
  if (publicOrigin) attachSelfHostedWeb(app);
  const base = publicOrigin
    ? publicOrigin.replace("https:", "http:")
    : "http://localhost:8790";
  const start = await app.request(`${base}/api/session`, {
    method: "POST",
    headers: {
      Origin: publicOrigin ?? base,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ consent: true }),
  });
  const session = await start.json();
  const headers = {
    Cookie: start.headers.get("set-cookie")!.split(";")[0]!,
    Origin: publicOrigin ?? base,
    "Content-Type": "application/json",
    "X-Saathi-CSRF": session.csrf,
  };
  const request = (path: string, body?: unknown, method = "POST", extra = {}) =>
    app.request(`${base}${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, request, headers, start };
}

test("source evidence survives API history and duplicate receipts without a second lookup", async () => {
  let calls = 0;
  const evidence = {
    sources: [
      { title: "Synthetic IMD", url: "https://mausam.imd.gov.in/chennai/" },
    ],
    searchedAt: "2026-10-29T00:00:00Z",
    searchCalls: 1,
  };
  const { request } = await fixture(async () => {
    calls++;
    return { text: "Synthetic cited answer", evidence };
  });
  const thread = await (
    await request("/api/threads", { agent: "saathi" })
  ).json();
  const body = {
    request_id: "synthetic-search",
    text: "Synthetic public lookup",
  };
  const first = await (
    await request(`/api/threads/${thread.id}/messages`, body)
  ).json();
  const duplicate = await (
    await request(`/api/threads/${thread.id}/messages`, body)
  ).json();
  expect(first.evidence).toEqual(evidence);
  expect(duplicate.evidence).toEqual(evidence);
  expect(duplicate.id).toBe(first.id);
  expect(calls).toBe(1);
  const saved = await (await request(`/api/threads/${thread.id}`)).json();
  expect(saved.messages.at(-1).evidence).toEqual(evidence);
});

test("public TLS proxy mode validates host/origin and secures sessions and raw assets", async () => {
  const { app, request, start } = await fixture(
    undefined,
    undefined,
    "https://saathi.example.test",
  );
  expect(start.headers.get("set-cookie")).toContain("Secure");
  expect((await request("/")).headers.get("strict-transport-security")).toBe(
    "max-age=86400",
  );
  expect((await app.request("http://wrong.example.test/health")).status).toBe(
    403,
  );
  expect(
    (
      await request("/api/threads", { agent: "saathi" }, "POST", {
        Origin: "http://saathi.example.test",
      })
    ).status,
  ).toBe(403);
  expect((await request("/api/threads", { agent: "saathi" })).status).toBe(201);
});

test("anonymous requests, cross-origin and forged CSRF fail before storage/model access", async () => {
  const { app, request } = await fixture();
  expect((await app.request("http://localhost:8790/api/threads")).status).toBe(
    401,
  );
  expect(
    (
      await request("/api/threads", { agent: "saathi" }, "POST", {
        Origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/threads", { agent: "saathi" }, "POST", {
        "X-Saathi-CSRF": "wrong",
      })
    ).status,
  ).toBe(403);
  expect((await app.request("https://public.example/api/session")).status).toBe(
    403,
  );
});

test("selection is server-eligible, persisted and duplicate-safe even during catalogue failure", async () => {
  let calls = 0,
    available = true;
  const choices = ["one", "two"].map((name) => ({
    id: `openrouter:synthetic/${name}:free`,
    provider: "openrouter" as const,
    model: `synthetic/${name}:free`,
    name,
    inputPerMillion: 0,
    outputPerMillion: 0,
  }));
  const { app, request } = await fixture(
    async (input) => {
      calls++;
      return `Selected ${input.model?.id}`;
    },
    async () => {
      if (!available) throw new Error("synthetic catalogue failure");
      return {
        models: choices,
        defaultModel: choices[0]!.id,
        allowPaid: false,
        metaEnabled: false,
        maxInputPrice: 0,
        maxOutputPrice: 0,
        checkedAt: 0,
        issues: [],
      };
    },
  );
  expect((await app.request("http://localhost:8790/api/models")).status).toBe(
    401,
  );
  expect((await (await request("/api/models")).json()).models).toHaveLength(2);
  const thread = await (
    await request("/api/threads", { agent: "saathi" })
  ).json();
  const bad = {
    request_id: "selected",
    text: "Synthetic",
    model: "openrouter:forged/paid",
  };
  expect(
    (await request(`/api/threads/${thread.id}/messages`, bad)).status,
  ).toBe(400);
  expect(calls).toBe(0);
  expect(
    (await (await request(`/api/threads/${thread.id}`)).json()).messages,
  ).toHaveLength(0);
  const body = { ...bad, model: choices[1]!.id };
  const result = await (
    await request(`/api/threads/${thread.id}/messages`, body)
  ).json();
  expect(result.model).toBe(choices[1]!.id);
  available = false;
  expect(
    (await request(`/api/threads/${thread.id}/messages`, body)).status,
  ).toBe(200);
  expect(
    (
      await request(`/api/threads/${thread.id}/messages`, {
        ...body,
        model: choices[0]!.id,
      })
    ).status,
  ).toBe(409);
  expect(calls).toBe(1);
  expect(
    (await (await request(`/api/threads/${thread.id}`)).json()).lastRun.model,
  ).toBe(choices[1]!.id);
});

test("chat and reviewed memory are durable, owned and not duplicated", async () => {
  let calls = 0;
  const { request, app } = await fixture(async ({ memories }) => {
    calls++;
    return `Synthetic ${memories.join(";")}`;
  });
  await request("/api/memories", {
    content: "Tamil preference",
    reviewed: true,
  });
  const thread = await (
    await request("/api/threads", { agent: "saathi" })
  ).json();
  const input = { request_id: "same-id", text: "Synthetic hello" };
  expect(
    (await request(`/api/threads/${thread.id}/messages`, input)).status,
  ).toBe(200);
  expect(
    (await request(`/api/threads/${thread.id}/messages`, input)).status,
  ).toBe(200);
  expect(calls).toBe(1);
  expect(
    (await (await request(`/api/threads/${thread.id}`)).json()).messages,
  ).toHaveLength(2);
  const other = await app.request("http://localhost:8790/api/session", {
    method: "POST",
    headers: {
      Origin: "http://localhost:8790",
      "Content-Type": "application/json",
    },
    body: '{"consent":true}',
  });
  const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;
  expect(
    (
      await request(`/api/threads/${thread.id}`, undefined, "POST", {
        Cookie: otherCookie,
      })
    ).status,
  ).toBe(404);
  expect(
    await (
      await request("/api/memories", undefined, "POST", { Cookie: otherCookie })
    ).json(),
  ).toEqual([]);
});

test("failure preserves a failed run; retrying the same ID never calls the provider again", async () => {
  let calls = 0;
  const { request } = await fixture(async () => {
    calls++;
    throw new Error("private-provider-payload");
  });
  const thread = await (
    await request("/api/threads", { agent: "saathi" })
  ).json();
  const input = { request_id: "failed", text: "hello" };
  const failed = await request(`/api/threads/${thread.id}/messages`, input);
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("private-provider-payload");
  const prior = await request(`/api/threads/${thread.id}/messages`, input);
  expect((await prior.json()).state).toBe("failed");
  expect(calls).toBe(1);
});

test("received bytes, unknown owner fields and unreviewed preferences are rejected", async () => {
  const { app, request, headers } = await fixture();
  expect(
    (await request("/api/threads", { agent: "saathi", owner: "forged" }))
      .status,
  ).toBe(422);
  expect(
    (await request("/api/memories", { content: "Unreviewed", reviewed: false }))
      .status,
  ).toBe(422);
  const response = await app.request("http://localhost:8790/api/memories", {
    method: "POST",
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(30000));
        controller.enqueue(new Uint8Array(30001));
        controller.close();
      },
    }),
  });
  expect(response.status).toBe(413);
  expect(await (await request("/api/memories")).json()).toEqual([]);
});

test("concurrent duplicates return pending while another new request conflicts", async () => {
  let release: (value: string) => void = () => {};
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { request } = await fixture(async () => {
    started();
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  });
  const thread = await (
    await request("/api/threads", { agent: "saathi" })
  ).json();
  const body = { request_id: "concurrent", text: "Synthetic request" };
  const first = request(`/api/threads/${thread.id}/messages`, body);
  await began;
  const duplicate = await request(`/api/threads/${thread.id}/messages`, body);
  expect(duplicate.status).toBe(202);
  expect((await duplicate.json()).state).toBe("running");
  expect(
    (
      await request(`/api/threads/${thread.id}/messages`, {
        ...body,
        request_id: "new",
      })
    ).status,
  ).toBe(409);
  release("Synthetic completion");
  expect((await first).status).toBe(200);
});
