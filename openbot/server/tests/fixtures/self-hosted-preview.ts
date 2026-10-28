import { resolve } from "node:path";
import { createSelfHostedApp } from "../../src/self-hosted/app";
import { LocalError, SelfHostedStore } from "../../src/self-hosted/store";
import { attachSelfHostedWeb } from "../../src/self-hosted/web";

// Explicit deterministic UI fixture, never selected by the real startup command.
const path = process.argv[2];
if (!path) throw new Error("Synthetic fixture database path required.");
const store = new SelfHostedStore(resolve(path));
const choices = ["one", "two"].map((name) => ({
  id: `openrouter:synthetic/${name}:free`,
  provider: "openrouter" as const,
  model: `synthetic/${name}:free`,
  name: `FIXTURE ${name} · no live inference`,
  inputPerMillion: 0,
  outputPerMillion: 0,
}));
const app = attachSelfHostedWeb(
  createSelfHostedApp({
    store,
    model: "FIXTURE - no live inference",
    models: async () => ({
      models: choices,
      defaultModel: choices[0]!.id,
      allowPaid: false,
      metaEnabled: false,
      maxInputPrice: 0,
      maxOutputPrice: 0,
      checkedAt: Date.now(),
      issues: [],
    }),
    answer: async ({ memories, model, messages }) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (messages.at(-1)?.content === "Synthetic provider failure")
        throw new LocalError(
          "Synthetic provider failure; no live inference.",
          503,
        );
      return `Synthetic fixture answer from ${model?.id}. Reviewed preferences: ${memories.join("; ") || "none"}.`;
    },
  }),
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8791,
  fetch: app.fetch,
});
console.log("Synthetic UI fixture only: http://127.0.0.1:8791");
const stop = () => {
  server.stop(true);
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
