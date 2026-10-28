import { z } from "zod";
import type { selfHostedConfig } from "./config";
import { boundedJson, type ProviderFetch } from "./http-json";

export type ModelChoice = {
  id: string;
  provider: "openrouter" | "meta";
  model: string;
  name: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
};
export type ModelCatalog = {
  models: ModelChoice[];
  defaultModel: string;
  allowPaid: boolean;
  metaEnabled: boolean;
  maxInputPrice: number;
  maxOutputPrice: number;
  checkedAt: number;
  issues: string[];
};
const modelId = z.string().regex(/^[A-Za-z0-9_./:-]{1,150}$/);
const envelope = z.object({ data: z.array(z.unknown()).max(2000) });
const textModel = z.object({
  id: modelId,
  name: z.string().max(200).optional(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  pricing: z.object({
    prompt: z.unknown(),
    completion: z.unknown(),
    request: z.unknown(),
  }),
  supported_parameters: z.array(z.string()),
});
function price(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
  )
    return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

/** Only key-filtered, operator-eligible models. Catalogue metadata is not inference evidence. */
export function createModelCatalog(
  config: ReturnType<typeof selfHostedConfig>,
  transport: { fetch?: ProviderFetch; now?: () => number } = {},
) {
  const call = transport.fetch ?? fetch,
    now = transport.now ?? Date.now;
  let cached: ModelCatalog | undefined,
    expires = 0,
    pending: Promise<ModelCatalog> | null = null;
  async function load(): Promise<ModelCatalog> {
    const models: ModelChoice[] = [],
      issues: string[] = [];
    const read = async (provider: "meta" | "openrouter", key: string) => {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await call(
          provider === "meta"
            ? "https://api.meta.ai/v1/models"
            : "https://openrouter.ai/api/v1/models/user",
          {
            method: "GET",
            redirect: "error",
            headers: { Authorization: `Bearer ${key}` },
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          try {
            await response.body?.cancel();
          } catch {}
          throw new Error("catalogue unavailable");
        }
        const parsed = envelope.parse(await boundedJson(response, 4_000_000));
        for (const raw of parsed.data) {
          if (provider === "meta") {
            const row = z.object({ id: modelId }).safeParse(raw);
            if (row.success && config.metaModels.includes(row.data.id))
              models.push({
                id: `meta:${row.data.id}`,
                provider,
                model: row.data.id,
                name: `Meta · ${row.data.id}`,
                inputPerMillion: null,
                outputPerMillion: null,
              });
          } else {
            const row = textModel.safeParse(raw);
            if (!row.success) continue;
            const m = row.data;
            const input = price(m.pricing.prompt),
              output = price(m.pricing.completion),
              fee = price(m.pricing.request);
            if (
              input === null ||
              output === null ||
              fee !== 0 ||
              !m.architecture.input_modalities.includes("text") ||
              !m.architecture.output_modalities.includes("text") ||
              !m.supported_parameters.includes("max_tokens")
            )
              continue;
            const free =
              input === 0 &&
              output === 0 &&
              (m.id.endsWith(":free") || m.id === "openrouter/free");
            if (
              !free &&
              (!config.allowPaid ||
                input * 1e6 > config.maxInputPrice ||
                output * 1e6 > config.maxOutputPrice)
            )
              continue;
            models.push({
              id: `openrouter:${m.id}`,
              provider,
              model: m.id,
              name: m.name || m.id,
              inputPerMillion: input * 1e6,
              outputPerMillion: output * 1e6,
            });
          }
        }
      } catch {
        issues.push(
          `${provider === "meta" ? "Meta" : "OpenRouter"} model list unavailable. Check the server key, permissions or provider capacity.`,
        );
      } finally {
        clearTimeout(timer);
      }
    };
    await Promise.allSettled([
      ...(config.apiKey ? [read("openrouter", config.apiKey)] : []),
      ...(config.metaEnabled && config.metaApiKey
        ? [read("meta", config.metaApiKey)]
        : []),
    ]);
    const unique = [...new Map(models.map((m) => [m.id, m])).values()];
    unique.sort(
      (a, b) =>
        (a.inputPerMillion ?? Infinity) - (b.inputPerMillion ?? Infinity) ||
        (a.outputPerMillion ?? Infinity) - (b.outputPerMillion ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
    return {
      models: unique,
      defaultModel: `openrouter:${config.model}`,
      allowPaid: config.allowPaid,
      metaEnabled: config.metaEnabled,
      maxInputPrice: config.maxInputPrice,
      maxOutputPrice: config.maxOutputPrice,
      checkedAt: now(),
      issues,
    };
  }
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending)
      pending = load()
        .then((result) => {
          cached = result;
          expires = now() + (result.issues.length ? 30_000 : 300_000);
          return result;
        })
        .finally(() => {
          pending = null;
        });
    return pending;
  };
}
