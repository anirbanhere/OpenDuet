import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { LocalError, type SelfHostedStore, type StoredMessage } from "./store";

export type AnswerInput = {
  agent: string;
  messages: StoredMessage[];
  memories: string[];
  runId: string;
  threadId: string;
};
type Session = { owner: string; csrf: string };
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createSelfHostedApp(options: {
  store: SelfHostedStore;
  answer: (input: AnswerInput) => Promise<string>;
  model: string;
}) {
  const { store, answer, model } = options;
  const app = new Hono<{ Variables: { session: Session; body: unknown } }>();
  const writes: number[] = [];
  app.onError((error, c) =>
    c.json(
      {
        error: {
          message:
            error instanceof LocalError
              ? error.message
              : "Local storage is unavailable. No external action was executed.",
        },
      },
      (error instanceof LocalError
        ? error.status
        : 503) as ContentfulStatusCode,
    ),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const url = new URL(c.req.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new LocalError("This Saathi mode is loopback-only.", 403);
    if (!["GET", "POST", "DELETE"].includes(c.req.method))
      throw new LocalError("Unsupported method.", 405);
    if (c.req.method !== "GET") {
      if (
        c.req.header("origin") !== url.origin ||
        c.req.header("content-type")?.split(";")[0] !== "application/json"
      )
        throw new LocalError("Use same-origin JSON.", 403);
      const now = Date.now();
      while (writes.length && (writes[0] ?? now) < now - 60_000) writes.shift();
      if (writes.length >= 100)
        throw new LocalError("Local request budget reached.", 429);
      writes.push(now);
      const declared = c.req.header("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > 60_000))
        throw new LocalError("Request exceeds60KB.", 413);
      const reader = c.req.raw.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 60_000) {
              await reader.cancel();
              throw new LocalError("Request exceeds60KB.", 413);
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      try {
        c.set("body", JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        throw new LocalError("Invalid JSON.", 400);
      }
    }
    if (
      url.pathname.startsWith("/api/") &&
      !(url.pathname === "/api/session" && c.req.method === "POST")
    ) {
      const session = store.session(getCookie(c, "saathi_self_hosted") ?? "");
      if (!session)
        throw new LocalError("Start a private local workspace.", 401);
      if (
        c.req.method !== "GET" &&
        !equal(c.req.header("x-saathi-csrf") ?? "", session.csrf)
      )
        throw new LocalError("Invalid action token.", 403);
      c.set("session", session);
    }
    await next();
  });
  const input = <T>(schema: z.ZodType<T>, body: unknown) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new LocalError("Invalid or unsupported request fields.");
    return parsed.data;
  };
  app.get("/health", (c) =>
    c.json({
      storage: "self-hosted-sqlite",
      actions: false,
      speech: false,
      model,
    }),
  );
  app.post("/api/session", (c) => {
    input(z.object({ consent: z.literal(true) }).strict(), c.var.body);
    const session = store.createSession();
    setCookie(c, "saathi_self_hosted", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 86400,
    });
    return c.json(
      { csrf: session.csrf, storage: "self-hosted-sqlite", model },
      201,
    );
  });
  app.get("/api/session", (c) =>
    c.json({ csrf: c.var.session.csrf, storage: "self-hosted-sqlite", model }),
  );
  app.get("/api/threads", (c) =>
    c.json(
      store
        .listThreads(c.var.session.owner)
        .map(({ owner: _owner, ...thread }) => thread),
    ),
  );
  app.post("/api/threads", (c) => {
    const body = input(
      z.object({ agent: z.enum(["saathi", "kitchen", "inventory"]) }).strict(),
      c.var.body,
    );
    const { owner: _owner, ...thread } = store.createThread(
      c.var.session.owner,
      body.agent,
    );
    return c.json(thread, 201);
  });
  app.get("/api/threads/:id", (c) => {
    const { owner: _owner, ...thread } = store.thread(
      c.var.session.owner,
      c.req.param("id"),
    );
    return c.json(thread);
  });
  app.delete("/api/threads/:id", (c) => {
    store.deleteThread(c.var.session.owner, c.req.param("id"));
    return c.json({ deleted: true });
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const body = input(
      z
        .object({
          request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          text: z.string().trim().min(1).max(2000),
        })
        .strict(),
      c.var.body,
    );
    const owner = c.var.session.owner,
      threadId = c.req.param("id");
    const run = store.beginRun(owner, threadId, body.request_id, body.text);
    if (!run.fresh)
      return c.json(
        { id: run.id, state: run.state, reply: run.reply },
        run.state === "running" ? 202 : 200,
      );
    try {
      const thread = store.thread(owner, threadId);
      // A bounded context window, not a fabricated summary of older history.
      let remaining = 24_000;
      const recent: StoredMessage[] = [];
      for (const message of thread.messages.toReversed()) {
        if (message.content.length > remaining) break;
        recent.unshift(message);
        remaining -= message.content.length;
      }
      const memories: string[] = [];
      let memoryBudget = 8000;
      for (const memory of store.memories(owner)) {
        if (memory.content.length > memoryBudget) break;
        memories.push(memory.content);
        memoryBudget -= memory.content.length;
      }
      const reply = await answer({
        agent: thread.agent,
        messages: recent,
        memories,
        runId: run.id,
        threadId,
      });
      store.completeRun(owner, run.id, reply);
      return c.json({ id: run.id, state: "completed", reply });
    } catch (error) {
      store.failRun(owner, run.id);
      throw error instanceof LocalError
        ? error
        : new LocalError(
            "The model request failed. Your message is saved; no action was executed.",
            502,
          );
    }
  });
  app.get("/api/memories", (c) => c.json(store.memories(c.var.session.owner)));
  app.post("/api/memories", (c) => {
    const body = input(
      z
        .object({
          content: z.string().trim().min(1).max(2000),
          reviewed: z.literal(true),
        })
        .strict(),
      c.var.body,
    );
    return c.json(
      store.saveMemory(c.var.session.owner, body.content, body.reviewed),
      201,
    );
  });
  app.delete("/api/memories/:id", (c) => {
    store.deleteMemory(c.var.session.owner, c.req.param("id"));
    return c.json({ deleted: true });
  });
  return app;
}
