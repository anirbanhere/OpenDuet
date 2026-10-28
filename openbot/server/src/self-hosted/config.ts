import { resolve } from "node:path";
import { LocalError } from "./store";

export function selfHostedConfig(
  env: Readonly<Record<string, string | undefined>>,
) {
  if (env.INTELLIGENCE_API_KEY?.trim() || env.CPK_INTELLIGENCE_API_KEY?.trim())
    throw new LocalError(
      "Remove cloud thread/memory credentials from the self-hosted profile.",
    );
  const model = env.BOT_MODEL?.trim() || "openrouter/free";
  if (model !== "openrouter/free" && !/^[A-Za-z0-9_./-]+:free$/.test(model))
    throw new LocalError(
      "Choose a free OpenRouter model; no paid fallback is enabled.",
    );
  if (
    env.OPENAI_BASE_URL &&
    env.OPENAI_BASE_URL !== "https://openrouter.ai/api/v1"
  )
    throw new LocalError(
      "This profile uses the OpenRouter compatible endpoint.",
    );
  const port = Number(env.SAATHI_PORT || 8790);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new LocalError("Choose a local port between1024 and65535.");
  if (env.SAATHI_HOST && env.SAATHI_HOST !== "127.0.0.1")
    throw new LocalError("The starter service is loopback-only.");
  return {
    host: "127.0.0.1" as const,
    port,
    path: resolve(
      env.SAATHI_DATABASE_PATH ||
        resolve(import.meta.dir, "../../../../.saathi/state.sqlite"),
    ),
    model,
    apiKey:
      env.OPENROUTER_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null,
  };
}
