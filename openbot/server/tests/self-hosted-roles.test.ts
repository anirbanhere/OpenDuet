import { expect, test } from "bun:test";
import { createAnswer } from "../src/self-hosted/answer";
import { selfHostedConfig } from "../src/self-hosted/config";
import { createModelCatalog } from "../src/self-hosted/models";
import { roleDiagnostics } from "../src/self-hosted/roles";

test("roles are independent immutable configurations and expose no credentials", () => {
  const base = selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-secret" });
  const changed = selfHostedConfig({
    OPENROUTER_API_KEY: "synthetic-secret",
    SAATHI_STT_PROVIDER: "fixture-b",
    SAATHI_TTS_PROVIDER: "fixture-a",
  });
  expect(changed.roles.reasoning).toEqual(base.roles.reasoning);
  expect(changed.roles.conversation).toEqual(base.roles.conversation);
  expect(base.roles.stt.provider).toBe("disabled");
  expect(changed.roles.stt.provider).toBe("fixture-b");
  expect(Object.isFrozen(changed.roles)).toBe(true);
  expect(Object.isFrozen(changed.roles.stt.languages)).toBe(true);
  expect(Reflect.set(changed.roles.conversation, "model", "forged")).toBe(
    false,
  );
  expect(JSON.stringify(roleDiagnostics(changed.roles))).not.toContain(
    "synthetic-secret",
  );
  expect(roleDiagnostics(changed.roles).liveSpeechEnabled).toBe(false);
});
test("role configuration cannot enable a disabled Meta provider, paid fallback or unbounded retry", () => {
  for (const env of [
    { SAATHI_REASONING_MODEL: "meta:muse-spark-1.3" },
    { SAATHI_CONVERSATION_MODEL: "openrouter:vendor/paid" },
    { SAATHI_STT_PROVIDER: "unknown" },
    { SAATHI_REASONING_TIMEOUT_MS: "120000" },
    { SAATHI_CONVERSATION_MAX_OUTPUT_TOKENS: "999999" },
    { SAATHI_STT_PROVIDER: "sarvam" },
  ])
    expect(() => selfHostedConfig(env)).toThrow();
  const configured = selfHostedConfig({
    SAATHI_STT_PROVIDER: "sarvam",
    SAATHI_STT_MODEL: "operator-configured-model",
  });
  expect(roleDiagnostics(configured.roles).stt.status).toBe("adapter_missing");
  expect(configured.roles.conversation.attempts).toBe(1);
});
test("separate reasoner/reply roles actually route to their own configured provider without changing default chat", async () => {
  const config = selfHostedConfig({
    OPENROUTER_API_KEY: "synthetic-router",
    META_API_KEY: "synthetic-meta",
    SAATHI_ENABLE_META: "true",
    SAATHI_REASONING_MODEL: "meta:muse-spark-1.3",
    SAATHI_REASONING_MAX_OUTPUT_TOKENS: "1536",
  });
  const requests: {
    url: string;
    body: Record<string, unknown>;
    key: string;
  }[] = [];
  const answer = await createAnswer(config, {
    fetch: async (url, init) => {
      requests.push({
        url,
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get("Authorization") || "",
      });
      return Response.json({
        choices: [
          { message: { content: "Synthetic response" }, finish_reason: "stop" },
        ],
      });
    },
  });
  const input = {
    agent: "saathi",
    threadId: "synthetic",
    runId: "synthetic",
    memories: [],
    messages: [
      { id: "synthetic", role: "user" as const, content: "Synthetic test" },
    ],
  };
  await answer(input);
  await answer({ ...input, purpose: "reasoning" });
  expect(requests[0]?.url).toBe(
    "https://openrouter.ai/api/v1/chat/completions",
  );
  expect(requests[0]?.key).toBe("Bearer synthetic-router");
  expect(requests[1]?.url).toBe("https://api.meta.ai/v1/chat/completions");
  expect(requests[1]?.key).toBe("Bearer synthetic-meta");
  expect(requests[1]?.body.max_completion_tokens).toBe(1536);
  await expect(answer({ ...input, purpose: "extraction" })).rejects.toThrow(
    "not configured",
  );
  expect(requests).toHaveLength(2);
});
test("operator conversation role determines catalogue default; browser selection still overrides it", async () => {
  const config = selfHostedConfig({
    OPENROUTER_API_KEY: "synthetic-router",
    META_API_KEY: "synthetic-meta",
    SAATHI_ENABLE_META: "true",
    SAATHI_CONVERSATION_MODEL: "meta:muse-spark-1.3",
  });
  const catalog = createModelCatalog(config, {
    fetch: async () => Response.json({ data: [{ id: "muse-spark-1.3" }] }),
  });
  expect((await catalog()).defaultModel).toBe("meta:muse-spark-1.3");
  expect(config.roles.reasoning.provider).toBe("openrouter");
  let endpoint = "";
  const answer = await createAnswer(config, {
    fetch: async (url) => {
      endpoint = url;
      return Response.json({
        choices: [{ message: { content: "Synthetic override" } }],
      });
    },
  });
  await answer({
    agent: "saathi",
    threadId: "synthetic",
    runId: "synthetic",
    memories: [],
    messages: [{ id: "synthetic", role: "user", content: "Synthetic" }],
    model: {
      id: "openrouter:openrouter/free",
      provider: "openrouter",
      model: "openrouter/free",
      name: "Synthetic",
      inputPerMillion: 0,
      outputPerMillion: 0,
    },
  });
  expect(endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
});
