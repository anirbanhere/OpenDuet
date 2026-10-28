import { SelfHostedStore } from "../../src/self-hosted/store";

const path = process.argv[2];
if (!path) throw new Error("Test database path required.");
const store = new SelfHostedStore(path);
const session = store.createSession();
const thread = store.createThread(session.owner, "saathi");
const run = store.beginRun(
  session.owner,
  thread.id,
  "pending",
  "Synthetic crash test",
);
console.log(
  JSON.stringify({ owner: session.owner, thread: thread.id, run: run.id }),
);
setInterval(() => {}, 1000);
