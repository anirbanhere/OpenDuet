import { selfHostedConfig } from "../../src/self-hosted/config";
import {
  syntheticSpeechFixture,
  type Transcript,
} from "../../src/self-hosted/speech";
import { SelfHostedStore } from "../../src/self-hosted/store";
import { FixtureSttCoordinator } from "../../src/self-hosted/stt-coordinator";

const path = process.argv[2];
if (!path) throw new Error("Synthetic test path required");
const store = new SelfHostedStore(path),
  session = store.createSession();
const roles = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles;
const media = store.media.admit(session.owner, {
  request_id: "synthetic",
  audio: syntheticSpeechFixture("en-IN").audio,
  mimeType: "audio/wav",
  consentToStore: true,
  consentToProcess: true,
});
const admission = store.sttAdmissions.begin(
  session.owner,
  {
    request_id: "synthetic",
    media_id: media.id,
    consent_revision: media.consentRevision,
  },
  roles.stt,
);
let started!: () => void,
  aborts = 0;
const ready = new Promise<void>((resolve) => {
  started = resolve;
});
const runner = new FixtureSttCoordinator(store.sttAdmissions, () => roles, {
  fixtureProvider: () => ({
    transcribe: (input) => {
      input.signal.addEventListener("abort", () => {
        aborts++;
      });
      started();
      return new Promise<Transcript>(() => {});
    },
  }),
});
const running = runner.run(session.owner, admission.id);
await ready;
runner.stop();
const stopped = await running;
// Only synthetic row identifiers and counts; no cookie/audio/executor token.
console.log(
  JSON.stringify({
    owner: session.owner,
    id: admission.id,
    state: stopped.state,
    pending: stopped.pending,
    aborts,
    workers: runner.stop().pendingWorkers,
  }),
);
setInterval(() => {}, 1000);
