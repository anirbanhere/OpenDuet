import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../openbot/server/src/self-hosted/config";
import { fixtureLanguages } from "../openbot/server/src/self-hosted/roles";
import { syntheticSpeechFixture } from "../openbot/server/src/self-hosted/speech";
import { SelfHostedStore } from "../openbot/server/src/self-hosted/store";
import { FixtureSttCoordinator } from "../openbot/server/src/self-hosted/stt-coordinator";

if (process.argv.length !== 2)
  throw new Error(
    "This command accepts no input or existing profile; it runs synthetic fixtures only.",
  );
let fetchAttempts = 0;
const blocked = () => {
  fetchAttempts++;
  throw new Error("Synthetic fixture mode disables fetch.");
};
globalThis.fetch = Object.assign(async () => blocked(), {
  preconnect: blocked,
});
const folder = mkdtempSync(join(tmpdir(), "saathi-stt-fixture-"));
function cleanup() {
  if (
    dirname(resolve(folder)) !== resolve(tmpdir()) ||
    !basename(folder).startsWith("saathi-stt-fixture-")
  )
    throw new Error("Unsafe fixture cleanup");
  rmSync(folder, { recursive: true, force: true });
}
let store: SelfHostedStore | undefined;
try {
  store = new SelfHostedStore(join(folder, "synthetic.sqlite"));
  const cases = [];
  for (const provider of ["fixture-a", "fixture-b"]) {
    // Explicit empty private configuration: no inherited keys/profile/data are used.
    const roles = selfHostedConfig({ SAATHI_STT_PROVIDER: provider }).roles;
    const runner = new FixtureSttCoordinator(store.sttAdmissions, () => roles);
    try {
      for (const language of fixtureLanguages) {
        const session = store.createSession(),
          fixture = syntheticSpeechFixture(language);
        const media = store.media.admit(session.owner, {
          request_id: "synthetic-clip",
          audio: fixture.audio,
          mimeType: "audio/wav",
          consentToStore: true,
          consentToProcess: true,
          languageHint: language,
        });
        const admission = store.sttAdmissions.begin(
          session.owner,
          {
            request_id: "synthetic-stt",
            media_id: media.id,
            consent_revision: media.consentRevision,
          },
          roles.stt,
        );
        const result = await runner.run(session.owner, admission.id);
        assert.equal(result.state, "completed");
        assert.equal(result.pending, false);
        assert.equal(result.outcome?.status, "completed");
        if (result.outcome?.status !== "completed")
          throw new Error("Fixture did not complete.");
        assert.equal(result.outcome.transcript.text, fixture.text);
        assert.deepEqual(await runner.run(session.owner, admission.id), result);
        cases.push({
          provider,
          language,
          mode: result.mode,
          state: result.state,
          duplicateReused: true,
        });
      }
    } finally {
      runner.stop();
      await runner.drain();
    }
  }
  assert.equal(fetchAttempts, 0);
  console.log(
    JSON.stringify(
      {
        scope: "fresh_synthetic_owned_stt_workflow",
        cases,
        fetchAttempts,
        realAsr: false,
        liveSpeechEnabled: false,
        note: "Generated tone lookup only. No existing profile, recordings, keys, public route or language-quality claim.",
      },
      null,
      2,
    ),
  );
} finally {
  store?.close();
  cleanup();
}
