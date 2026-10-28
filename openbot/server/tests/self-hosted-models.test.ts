import { expect, test } from "bun:test";
import { selfHostedConfig } from "../src/self-hosted/config";
import { createModelCatalog } from "../src/self-hosted/models";

const row = (
  id: string,
  prompt = "0",
  completion = "0",
  request: unknown = "0",
) => ({
  id,
  name: id,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt, completion, request },
  supported_parameters: ["max_tokens"],
});
const config = (extra = {}) =>
  selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-router", ...extra });

test("catalogue is key-filtered, free-only and bounded; malformed prices and extra fees are excluded", async () => {
  const urls: string[] = [];
  const catalog = createModelCatalog(config(), {
    fetch: async (url, init) => {
      urls.push(url);
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer synthetic-router",
      );
      return Response.json({
        data: [
          row("vendor/ok:free"),
          row("vendor/cheap", "0.0000001", "0.0000005"),
          row("vendor/negative:free", "-1"),
          row("vendor/fee:free", "0", "0", "0.1"),
          { id: "vendor/missing:free" },
          row("vendor/bad:free", "NaN"),
        ],
      });
    },
  });
  const result = await catalog();
  expect(urls).toEqual(["https://openrouter.ai/api/v1/models/user"]);
  expect(result.models.map((m) => m.id)).toEqual(["openrouter:vendor/ok:free"]);
  expect(JSON.stringify(result)).not.toContain("synthetic-router");
});

test("current OpenRouter rows may omit request pricing; explicit unknown or nonzero fees remain excluded", async () => {
  const omitted = {
    ...row("vendor/omitted:free"),
    pricing: { prompt: "0", completion: "0" },
  };
  const catalog = createModelCatalog(config(), {
    fetch: async () =>
      Response.json({
        data: [
          omitted,
          row("vendor/null:free", "0", "0", null),
          row("vendor/fee:free", "0", "0", "0.01"),
        ],
      }),
  });
  expect((await catalog()).models.map((m) => m.model)).toEqual([
    "vendor/omitted:free",
  ]);
});

test("cheap opt-in respects both token ceilings and never grants unknown pricing", async () => {
  const catalog = createModelCatalog(
    config({ SAATHI_ALLOW_PAID_MODELS: "true" }),
    {
      fetch: async () =>
        Response.json({
          data: [
            row("vendor/cheap", "0.0000001", "0.0000005"),
            row("vendor/high-input", "0.0001", "0"),
            row("vendor/high-output", "0", "0.0001"),
            row("vendor/ok:free"),
          ],
        }),
    },
  );
  const result = await catalog();
  expect(result.models.map((m) => m.model)).toEqual([
    "vendor/ok:free",
    "vendor/cheap",
  ]);
  expect(result.models[1]?.inputPerMillion).toBeCloseTo(0.1);
});

test("Meta uses its own key, team catalogue and Standard-mode allowlist", async () => {
  const seen: string[] = [];
  const catalog = createModelCatalog(
    config({ SAATHI_ENABLE_META: "true", META_API_KEY: "synthetic-meta" }),
    {
      fetch: async (url, init) => {
        const key = new Headers(init.headers).get("Authorization");
        seen.push(`${url} ${key}`);
        return url.startsWith("https://api.meta.ai/")
          ? Response.json({
              data: [
                { id: "muse-spark-1.3" },
                { id: "muse-spark-1.3-contributor" },
                { id: "muse-image-1.0" },
                { id: "muse-wonder-1.0" },
              ],
            })
          : Response.json({ data: [row("vendor/ok:free")] });
      },
    },
  );
  const result = await catalog();
  expect(seen).toContain("https://api.meta.ai/v1/models Bearer synthetic-meta");
  expect(seen).toContain(
    "https://openrouter.ai/api/v1/models/user Bearer synthetic-router",
  );
  const meta = result.models.filter((m) => m.provider === "meta");
  expect(meta.map((m) => m.id)).toEqual(["meta:muse-spark-1.3"]);
  expect(meta[0]?.inputPerMillion).toBeNull();
});

test("metadata requests coalesce, expire and recover without raw error exposure", async () => {
  let calls = 0,
    now = 0;
  const catalog = createModelCatalog(config(), {
    now: () => now,
    fetch: async () => {
      calls++;
      return calls === 1
        ? Response.json({ data: [row("vendor/ok:free")] })
        : Response.json(
            { error: "synthetic-private-payload" },
            { status: 403 },
          );
    },
  });
  await Promise.all([catalog(), catalog()]);
  expect(calls).toBe(1);
  now = 300001;
  const failed = await catalog();
  expect(calls).toBe(2);
  expect(failed.models).toEqual([]);
  expect(JSON.stringify(failed)).not.toContain("synthetic-private");
  await catalog();
  expect(calls).toBe(2);
});

test("oversized or unsupported catalogues fail closed; keyless startup makes no request", async () => {
  const missing = createModelCatalog(selfHostedConfig({}), {
    fetch: async () => {
      throw new Error("must not call");
    },
  });
  expect((await missing()).models).toEqual([]);
  const huge = createModelCatalog(config(), {
    fetch: async () => new Response("x".repeat(4_000_001)),
  });
  expect((await huge()).models).toEqual([]);
  const invalid = createModelCatalog(config(), {
    fetch: async () => Response.json({ data: "invalid" }),
  });
  expect((await invalid()).models).toEqual([]);
});
