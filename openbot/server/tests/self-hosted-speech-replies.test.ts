import { expect, test } from "bun:test";
import type { SpeechRole } from "../src/self-hosted/roles";
import {
  type SpeechAudio,
  syntheticSpeechFixture,
  type TextToSpeechProvider,
} from "../src/self-hosted/speech";
import { createSpeechReplies } from "../src/self-hosted/speech-replies";
import {
  createElevenLabsTts,
  createSarvamTts,
} from "../src/self-hosted/vendor-tts";

const role = (): SpeechRole => ({
  provider: "elevenlabs",
  model: "eleven_v3",
  languages: ["en-IN", "hi-IN", "ta-IN"],
  timeoutMs: 1000,
});
const request = (
  policy: "text_only" | "voice_only" | "text_and_voice" = "voice_only",
) => ({
  policy,
  text: "தமிழ் synthetic reply",
  language: "ta-IN" as const,
  consentToProcess: true,
  signal: new AbortController().signal,
});
const audio = (): SpeechAudio => ({
  bytes: syntheticSpeechFixture("ta-IN").audio,
  mimeType: "audio/wav",
  language: "ta-IN",
  durationMs: 250,
  isSpeech: true,
  warnings: [],
  source: { mode: "live", provider: "elevenlabs", model: "eleven_v3" },
});

test("text_only never calls TTS, even without speech consent or an enabled role", async () => {
  let calls = 0;
  const composer = createSpeechReplies(
    { ...role(), provider: "disabled", model: null },
    {
      synthesize: async () => {
        calls++;
        throw new Error("must not call");
      },
    },
  );
  const result = await composer.compose({
    ...request("text_only"),
    text: "x".repeat(2000),
    consentToProcess: false,
  });
  expect(result.status).toBe("text_ready");
  expect(result.text).toHaveLength(2000);
  expect(result.audio).toBeNull();
  expect(calls).toBe(0);
});

test("voice policies call the pinned adapter once with exact text and consent, then detach returned bytes", async () => {
  for (const policy of ["voice_only", "text_and_voice"] as const) {
    let calls = 0;
    const generated = audio(),
      input = request(policy);
    const composer = createSpeechReplies(role(), {
      synthesize: async (value) => {
        calls++;
        expect(value.text).toBe(input.text);
        expect(value.language).toBe(input.language);
        expect(value.consentToProcess).toBe(true);
        expect(value.signal).toBeInstanceOf(AbortSignal);
        return generated;
      },
    });
    const result = await composer.compose(input);
    expect(result.status).toBe("voice_ready");
    expect(result.text).toBe(policy === "voice_only" ? null : input.text);
    expect(result.audio?.bytes).toEqual(generated.bytes);
    expect(result.audio?.bytes).not.toBe(generated.bytes);
    generated.bytes[0] = 0;
    expect(result.audio?.bytes[0]).toBe(82);
    expect(calls).toBe(1);
  }
});

test("consent, role, adapter, locale and short-text gates never silently turn voice_only into text", async () => {
  let calls = 0;
  const adapter: TextToSpeechProvider = {
    synthesize: async () => {
      calls++;
      return audio();
    },
  };
  const composer = createSpeechReplies(role(), adapter);
  for (const consent of [false, undefined]) {
    const result = await composer.compose({
      ...request(),
      consentToProcess: consent,
    });
    expect(result.status).toBe("requires_consent");
    expect(result.text).toBeNull();
    expect(result.audio).toBeNull();
  }
  const cases = [
    await createSpeechReplies(
      { ...role(), provider: "disabled", model: null },
      adapter,
    ).compose(request()),
    await createSpeechReplies(role()).compose(request()),
    await composer.compose({ ...request(), language: "kn-IN" }),
    await composer.compose({ ...request(), text: "x".repeat(501) }),
  ];
  expect(cases.map((result) => result.reason)).toEqual([
    "role_disabled",
    "adapter_missing",
    "language_unavailable",
    "text_too_long",
  ]);
  for (const result of cases) {
    expect(result.status).toBe("unavailable");
    expect(result.text).toBeNull();
    expect(result.audio).toBeNull();
  }
  await expect(
    composer.compose({ ...request(), policy: "automatic" }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    composer.compose({ ...request(), consentToProcess: "yes" }),
  ).rejects.toMatchObject({ status: 422 });
  await expect(
    composer.compose({ ...request(), secret: "untrusted" }),
  ).rejects.toMatchObject({ status: 422 });
  expect(calls).toBe(0);
});

test("voice failures are sanitized; text_and_voice keeps text without pretending audio or delivery succeeded", async () => {
  let calls = 0;
  const composer = createSpeechReplies(role(), {
    synthesize: async () => {
      calls++;
      throw new Error("synthetic-private-key or provider text");
    },
  });
  for (const policy of ["voice_only", "text_and_voice"] as const) {
    const result = await composer.compose(request(policy));
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("tts_failed");
    expect(result.audio).toBeNull();
    expect(result.text).toBe(policy === "voice_only" ? null : request().text);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  }
  expect(calls).toBe(2);
});

test("malformed, wrong-language, forged duration or mismatched identity cannot become deliverable voice", async () => {
  const variants: unknown[] = [
    { ...audio(), bytes: new Uint8Array(100) },
    { ...audio(), durationMs: 999 },
    { ...audio(), language: "hi-IN" },
    { ...audio(), source: { ...audio().source, provider: "sarvam" } },
    { ...audio(), source: { ...audio().source, model: "different" } },
    { ...audio(), source: { ...audio().source, mode: "fixture" } },
    { ...audio(), isSpeech: false },
    { ...audio(), mimeType: "audio/mpeg" },
  ];
  for (const candidate of variants) {
    let calls = 0;
    const composer = createSpeechReplies(role(), {
      synthesize: async () => {
        calls++;
        return candidate as SpeechAudio;
      },
    });
    const result = await composer.compose(request());
    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("invalid_audio");
    expect(result.audio).toBeNull();
    expect(calls).toBe(1);
  }
});

test("fixture tones are explicit nondeliverable evidence and cannot claim to be real speech", async () => {
  const fixtureRole: SpeechRole = {
    ...role(),
    provider: "fixture-a",
    model: "synthetic-tone-v1",
  };
  const fixtureAudio = {
    ...audio(),
    isSpeech: false,
    source: {
      mode: "fixture" as const,
      provider: "fixture-a",
      model: "synthetic-tone-v1",
    },
  };
  const composer = createSpeechReplies(fixtureRole, {
    synthesize: async () => fixtureAudio,
  });
  const result = await composer.compose(request("text_and_voice"));
  expect(result.status).toBe("fixture_only");
  expect(result.reason).toBe("synthetic_tone");
  expect(result.text).toBe(request().text);
  expect(result.audio).toBeNull();
  const liar = createSpeechReplies(fixtureRole, {
    synthesize: async () => ({ ...fixtureAudio, isSpeech: true }),
  });
  expect((await liar.compose(request())).reason).toBe("invalid_audio");
});

test("pre, immediate and in-flight cancellation suppress late audio without another adapter attempt", async () => {
  let calls = 0,
    aborts = 0,
    finish: ((audio: SpeechAudio) => void) | undefined;
  const composer = createSpeechReplies(role(), {
    synthesize: async (input) => {
      calls++;
      input.signal.addEventListener("abort", () => aborts++);
      return new Promise<SpeechAudio>((resolve) => {
        finish = resolve;
      });
    },
  });
  const pre = new AbortController();
  pre.abort();
  await expect(
    composer.compose({ ...request(), signal: pre.signal }),
  ).rejects.toMatchObject({ status: 408 });
  const immediate = new AbortController();
  const stopped = composer.compose({ ...request(), signal: immediate.signal });
  immediate.abort();
  await expect(stopped).rejects.toMatchObject({ status: 408 });
  expect(calls).toBe(0);
  const active = new AbortController();
  const pending = composer.compose({ ...request(), signal: active.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  active.abort();
  await expect(pending).rejects.toMatchObject({ status: 408 });
  finish?.(audio());
  expect(calls).toBe(1);
  expect(aborts).toBe(1);
});

test("a hanging adapter times out once and composition pins the selected role before caller mutation", async () => {
  let calls = 0,
    aborted = false;
  const hanging = createSpeechReplies(role(), {
    synthesize: async (input) => {
      calls++;
      input.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<SpeechAudio>(() => {});
    },
  });
  const result = await hanging.compose(request());
  expect(result.status).toBe("unavailable");
  expect(result.reason).toBe("tts_timeout");
  expect(result.text).toBeNull();
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
  const mutable = role(),
    pinned = createSpeechReplies(mutable, { synthesize: async () => audio() });
  mutable.model = "other";
  mutable.provider = "sarvam";
  mutable.languages.length = 0;
  expect((await pinned.compose(request())).status).toBe("voice_ready");
});

test("both real transport implementations compose through mocked HTTP without changing reply policy or locale", async () => {
  const fixture = syntheticSpeechFixture("ta-IN").audio;
  for (const provider of ["sarvam", "elevenlabs"] as const) {
    let calls = 0;
    const model = provider === "sarvam" ? "bulbul:v3" : "eleven_v3";
    const fetch = async (_url: string, init: RequestInit) => {
      calls++;
      const headers = new Headers(init.headers);
      expect(
        headers.get(
          provider === "sarvam" ? "api-subscription-key" : "xi-api-key",
        ),
      ).toBe("synthetic-key");
      return provider === "sarvam"
        ? Response.json({ audios: [Buffer.from(fixture).toString("base64")] })
        : new Response(fixture.slice(44), {
            headers: { "content-type": "audio/pcm" },
          });
    };
    const options = {
      model,
      voice: "authorized_voice",
      apiKey: "synthetic-key",
      allowLiveRequests: true,
      fetch,
    };
    const adapter =
      provider === "sarvam"
        ? createSarvamTts(options)
        : createElevenLabsTts(options);
    const result = await createSpeechReplies(
      { ...role(), provider, model },
      adapter,
    ).compose(request("text_and_voice"));
    expect(result.status).toBe("voice_ready");
    expect(result.text).toBe(request().text);
    expect(result.audio?.language).toBe("ta-IN");
    expect(result.audio?.durationMs).toBe(provider === "sarvam" ? 250 : 167);
    expect(calls).toBe(1);
  }
});
