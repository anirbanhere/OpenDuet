import { selfHostedConfig } from "../openbot/server/src/self-hosted/config";

const config = selfHostedConfig(process.env);
console.log(
  "Self-hosted profile valid. Threads/reviewed memories: local SQLite; no Intelligence service.",
);
console.log(
  `Local binding: ${config.host}:${config.port}. Model: ${config.model}.`,
);
console.log(
  `OpenRouter key: ${config.apiKey ? "configured" : "missing"}; paid models: ${config.allowPaid ? `enabled within ${config.maxInputPrice}/${config.maxOutputPrice} USD per million token ceilings` : "disabled"}. Meta key: ${config.metaApiKey ? "configured" : "missing"}; Meta inference: ${config.metaEnabled ? "enabled, billing/availability unverified" : "disabled"}. Actions/speech/background jobs: unavailable.`,
);
