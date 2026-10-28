import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { SelfHostedStore } from "../src/self-hosted/store";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
async function fixture(
  answer = async (input: { memories: string[] }) =>
    `Remembered: ${input.memories.join(";") || "nothing"}`,
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
  const app = createSelfHostedApp({ store, answer, model: "synthetic:free" });
  const start = await app.request("http://localhost:8790/api/session", {
    method: "POST",
    headers: {
      Origin: "http://localhost:8790",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ consent: true }),
  });
  const session = await start.json();
  const headers = {
    Cookie: start.headers.get("set-cookie")!.split(";")[0]!,
    Origin: "http://localhost:8790",
    "Content-Type": "application/json",
    "X-Saathi-CSRF": session.csrf,
  };
  const request = (path: string, body?: unknown, method = "POST", extra = {}) =>
    app.request(`http://localhost:8790${path}`, {
      method: body === undefined ? "GET" : method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, request, headers };
}

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
