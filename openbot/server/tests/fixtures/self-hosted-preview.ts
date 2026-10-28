import { resolve } from "node:path";
import { createSelfHostedApp } from "../../src/self-hosted/app";
import { SelfHostedStore } from "../../src/self-hosted/store";
import { attachSelfHostedWeb } from "../../src/self-hosted/web";

// Explicit deterministic UI fixture, never selected by the real startup command.
const path = process.argv[2];
if (!path) throw new Error("Synthetic fixture database path required.");
const store = new SelfHostedStore(resolve(path));
const app = attachSelfHostedWeb(
  createSelfHostedApp({
    store,
    model: "FIXTURE - no live inference",
    answer: async ({ memories }) =>
      `Synthetic fixture answer. Reviewed preferences: ${memories.join("; ") || "none"}.`,
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
