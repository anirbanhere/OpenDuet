import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAnswer } from "../src/self-hosted/answer";
import { selfHostedConfig } from "../src/self-hosted/config";

const input = () => ({
  agent: "saathi",
  threadId: randomUUID(),
  runId: randomUUID(),
  messages: [
    { id: randomUUID(), role: "user" as const, content: "Synthetic hello" },
  ],
  memories: ["Synthetic preference: reply briefly"],
});

test("the tenant/model HTTP path receives reviewed context without a cloud memory request", async () => {
  const urls: string[] = [];
  let sent = "";
  const answer = await createAnswer(
    selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-key" }),
    {
      fetch: async (url, init) => {
        urls.push(String(url));
        sent = String(init?.body);
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Synthetic model answer.",
              },
            },
          ],
        });
      },
    },
  );
  expect(await answer(input())).toBe("Synthetic model answer.");
  expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  expect(sent).toContain("Synthetic preference: reply briefly");
  expect(JSON.parse(sent).tools).toBeUndefined();
  expect(JSON.parse(sent).provider).toEqual({
    allow_fallbacks: false,
    sort: "price",
    max_price: { prompt: 0, completion: 0, request: 0 },
  });
});

test("Meta chat uses only its own key and stateless endpoint with the selected Standard model", async () => {
  let endpoint = "",
    key = "",
    body: Record<string, unknown> = {};
  const answer = await createAnswer(
    selfHostedConfig({
      META_API_KEY: "synthetic-meta",
      SAATHI_ENABLE_META: "true",
    }),
    {
      fetch: async (url, init) => {
        endpoint = url;
        key = new Headers(init.headers).get("Authorization") || "";
        body = JSON.parse(String(init.body));
        return Response.json({
          choices: [
            {
              message: { content: "Synthetic Meta answer" },
              finish_reason: "stop",
            },
          ],
        });
      },
    },
  );
  await answer({
    ...input(),
    model: {
      id: "meta:muse-spark-1.3",
      provider: "meta",
      model: "muse-spark-1.3",
      name: "Synthetic",
      inputPerMillion: null,
      outputPerMillion: null,
    },
  });
  expect(endpoint).toBe("https://api.meta.ai/v1/chat/completions");
  expect(key).toBe("Bearer synthetic-meta");
  expect(body.model).toBe("muse-spark-1.3");
  expect(body.provider).toBeUndefined();
  expect(body.store).toBe(false);
  expect(body.previous_response_id).toBeUndefined();
  expect(body.max_completion_tokens).toBe(1024);
  expect((body.messages as { role: string }[])[0]?.role).toBe("developer");
});

test("a disabled provider or paid choice is rejected without an outbound attempt", async () => {
  let calls = 0;
  const answer = await createAnswer(
    selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-router" }),
    {
      fetch: async () => {
        calls++;
        throw new Error("must not call");
      },
    },
  );
  for (const provider of ["meta", "openrouter"] as const)
    await expect(
      answer({
        ...input(),
        model: {
          id: `${provider}:expensive`,
          provider,
          model: "expensive",
          name: "Synthetic",
          inputPerMillion: 1,
          outputPerMillion: 1,
        },
      }),
    ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("provider429 is one attempt and never logs a raw provider payload", async () => {
  let calls = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      return Response.json(
        { error: { message: "synthetic-private-error-payload", code: 429 } },
        { status: 429 },
      );
    },
  });
  const originalError = console.error,
    originalWarn = console.warn;
  const errors: unknown[][] = [];
  console.error = (...args) => {
    errors.push(args);
  };
  console.warn = () => {};
  try {
    const answer = await createAnswer(
      selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-key" }),
      { fetch: async (_url, init) => fetch(proxy.url, init) },
    );
    await expect(answer(input())).rejects.toThrow();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(0);
  } finally {
    await proxy.stop(true);
    console.error = originalError;
    console.warn = originalWarn;
  }
});

test.each([
  {
    choices: [
      {
        message: { role: "assistant", content: "partial" },
        finish_reason: "length",
      },
    ],
  },
  {
    choices: [
      {
        message: {
          role: "assistant",
          content: "I paid",
          tool_calls: [{ id: "ungranted" }],
        },
      },
    ],
  },
  { choices: [{ message: { role: "assistant", content: "" } }] },
])(
  "malformed, truncated and tool-claim responses are refused %j",
  async (body) => {
    const answer = await createAnswer(
      selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-key" }),
      { fetch: async () => Response.json(body) },
    );
    await expect(answer(input())).rejects.toThrow();
  },
);

test("received provider response bytes are bounded", async () => {
  const answer = await createAnswer(
    selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-key" }),
    { fetch: async () => new Response("x".repeat(64001)) },
  );
  await expect(answer(input())).rejects.toThrow("byte budget");
});
