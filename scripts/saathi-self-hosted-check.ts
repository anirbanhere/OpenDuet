import { selfHostedConfig } from "../openbot/server/src/self-hosted/config";

const config = selfHostedConfig(process.env);
console.log(
  "Self-hosted profile valid. Threads/reviewed memories: local SQLite; no Intelligence service.",
);
console.log(
  `Local binding: ${config.host}:${config.port}. Model: ${config.model}.`,
);
console.log(
  `Chat key: ${config.apiKey ? "configured, capacity unverified" : "missing; storage UI still starts"}. Actions/speech/background jobs: unavailable.`,
);
