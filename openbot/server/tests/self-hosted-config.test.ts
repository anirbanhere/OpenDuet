import { expect, test } from "bun:test";
import { selfHostedConfig } from "../src/self-hosted/config";

test("local storage starts without cloud credentials or model keys", () => {
  const config = selfHostedConfig({});
  expect(config.apiKey).toBeNull();
  expect(config.host).toBe("127.0.0.1");
  expect(config.model).toBe("openrouter/free");
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
