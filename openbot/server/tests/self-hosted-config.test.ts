import { expect, test } from "bun:test";
import { selfHostedConfig } from "../src/self-hosted/config";

test("local storage starts without cloud credentials or model keys", () => {
  const config = selfHostedConfig({});
  expect(config.apiKey).toBeNull();
  expect(config.host).toBe("127.0.0.1");
  expect(config.model).toBe("openrouter/free");
});

test("paid OpenRouter and Meta are separate explicit opt-ins", () => {
  const free = selfHostedConfig({ META_API_KEY: "synthetic-meta" });
  expect(free.allowPaid).toBe(false);
  expect(free.metaEnabled).toBe(false);
  const configured = selfHostedConfig({
    SAATHI_ALLOW_PAID_MODELS: "true",
    BOT_MODEL: "vendor/cheap",
    SAATHI_ENABLE_META: "true",
    META_API_KEY: "synthetic-meta",
  });
  expect(configured.metaApiKey).toBe("synthetic-meta");
  expect(configured.metaModels).toEqual(["muse-spark-1.3"]);
  expect(configured.maxInputPrice).toBe(0.25);
  expect(configured.maxOutputPrice).toBe(1);
});

test("public sharing requires a canonical HTTPS origin and bounded daily limits", () => {
  const config = selfHostedConfig({
    SAATHI_PUBLIC_ORIGIN: "https://saathi.example.test",
  });
  expect(config.publicOrigin).toBe("https://saathi.example.test");
  expect(config.dailyLimits).toEqual({ global: 20, owner: 5 });
  expect(config.host).toBe("127.0.0.1");
  for (const origin of [
    "http://example.test",
    "https://user:pass@example.test",
    "https://example.test/path",
    "https://example.test/?x=1",
  ])
    expect(() => selfHostedConfig({ SAATHI_PUBLIC_ORIGIN: origin })).toThrow();
  expect(() =>
    selfHostedConfig({
      SAATHI_PUBLIC_ORIGIN: "https://example.test",
      SAATHI_DAILY_CALLS: "0",
    }),
  ).toThrow();
});

test.each([
  { SAATHI_ALLOW_PAID_MODELS: "yes" },
  { SAATHI_MAX_INPUT_PRICE: "NaN" },
  { SAATHI_MAX_OUTPUT_PRICE: "-1" },
  { SAATHI_ENABLE_META: "true" },
  { SAATHI_META_MODELS: "muse-spark-1.3-contributor" },
])("rejects ambiguous spend or unsupported Meta configuration %j", (env) => {
  expect(() => selfHostedConfig(env)).toThrow();
});
test.each([
  { INTELLIGENCE_API_KEY: "synthetic-cloud-key" },
  { CPK_INTELLIGENCE_API_KEY: "synthetic-cloud-key" },
  { BOT_MODEL: "paid/model" },
  { SAATHI_HOST: "0.0.0.0" },
  { SAATHI_PORT: "0" },
  { OPENAI_BASE_URL: "https://api.openai.com/v1" },
])("rejects a mixed cloud, paid or public profile %j", (env) => {
  expect(() => selfHostedConfig(env)).toThrow();
});
