import assert from "node:assert/strict";
import { selfHostedConfig } from "../openbot/server/src/self-hosted/config";
import {
  fixtureLanguages,
  roleDiagnostics,
} from "../openbot/server/src/self-hosted/roles";
import {
  createSpeech,
  syntheticSpeechFixture,
} from "../openbot/server/src/self-hosted/speech";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--fixture"))
  throw new Error(
    "Use no arguments for configuration diagnostics, or --fixture for synthetic adapter evaluation. No live speech command is available.",
  );
if (!args.includes("--fixture")) {
  console.log(
    JSON.stringify(
      {
        scope: "configuration_only",
        roles: roleDiagnostics(selfHostedConfig(process.env).roles),
        note: "Configured models are not probed. No live speech or public audio path is enabled.",
      },
      null,
      2,
    ),
  );
} else {
  let networkRequests = 0;
  const blockedRequest = () => {
    networkRequests++;
    throw new Error("Network is disabled for synthetic fixture evaluation.");
  };
  globalThis.fetch = Object.assign(async () => blockedRequest(), {
    preconnect: blockedRequest,
  });
  const cases = [];
  for (const provider of ["fixture-a", "fixture-b"]) {
    // Intentionally ignore private/inherited configuration in fixture mode.
    const config = selfHostedConfig({
        SAATHI_STT_PROVIDER: provider,
        SAATHI_TTS_PROVIDER: "fixture-b",
      }),
      speech = createSpeech(config.roles);
    for (const language of fixtureLanguages) {
      const fixture = syntheticSpeechFixture(language),
        transcript = await speech.transcribe({
          audio: fixture.audio,
          mimeType: "audio/wav",
          languageHint: language,
          consentToProcess: true,
        }),
        audio = await speech.synthesize({
          text: transcript.text,
          language,
          consentToProcess: true,
        });
      assert.equal(transcript.text, fixture.text);
      assert.equal(audio.isSpeech, false);
      cases.push({
        sttProvider: provider,
        ttsProvider: audio.source.provider,
        language,
        mode: transcript.source.mode,
        matchedSyntheticPreset: true,
        outputIsSpeech: audio.isSpeech,
        outputBytes: audio.bytes.length,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        scope: "synthetic_adapter_contracts_only",
        passed: cases.length,
        cases,
        liveSpeechEnabled: false,
        networkRequests,
        qualityBenchmark: false,
        note: "Input is synthetic tone lookup and output is a generated tone. This is not an ASR/TTS quality or language-accuracy evaluation.",
      },
      null,
      2,
    ),
  );
}
