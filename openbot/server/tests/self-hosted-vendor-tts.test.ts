import { expect, test } from "bun:test";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import {
  createElevenLabsTts,
  createSarvamTts,
} from "../src/self-hosted/vendor-tts";
import { inspectPcmWav } from "../src/self-hosted/wav";

const input = () => ({
  text: "தமிழ் test",
  language: "ta-IN" as const,
  consentToProcess: true as const,
  signal: new AbortController().signal,
});
test("Sarvam TTS fixes model/voice/locale/key and validates the single returned base64 WAV", async () => {
  const fixture = syntheticSpeechFixture("en-IN").audio;
  let calls = 0;
  const tts = createSarvamTts({
    model: "bulbul:v3",
    voice: "shubh",
    apiKey: "synthetic-sarvam",
    allowLiveRequests: true,
    fetch: async (url, init) => {
      calls++;
      expect(url).toBe("https://api.sarvam.ai/text-to-speech");
      expect(new Headers(init.headers).get("api-subscription-key")).toBe(
        "synthetic-sarvam",
      );
      expect(new Headers(init.headers).has("xi-api-key")).toBe(false);
      expect(init.redirect).toBe("error");
      expect(JSON.parse(String(init.body))).toEqual({
        text: "தமிழ் test",
        language_code: "ta-IN",
        model: "bulbul:v3",
        speaker: "shubh",
        speech_sample_rate: 24000,
        output_audio_codec: "wav",
      });
      return Response.json({
        audios: [Buffer.from(fixture).toString("base64")],
      });
    },
  });
  const audio = await tts.synthesize(input());
  expect(audio.bytes).toEqual(fixture);
  expect(audio.durationMs).toBe(250);
  expect(audio.language).toBe("ta-IN");
  expect(audio.source).toEqual({
    mode: "live",
    provider: "sarvam",
    model: "bulbul:v3",
  });
  expect(audio.isSpeech).toBe(true);
  expect(calls).toBe(1);
});

test("ElevenLabs TTS uses an explicit voice and retention intent, wrapping24kHz S16LE without MP3 decoding", async () => {
  const pcm = syntheticSpeechFixture("en-IN").audio.slice(44);
  const tts = createElevenLabsTts({
    model: "eleven_v3",
    voice: "authorized_voice",
    apiKey: "synthetic-eleven",
    allowLiveRequests: true,
    fetch: async (url, init) => {
      expect(url).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/authorized_voice?output_format=pcm_24000&enable_logging=false",
      );
      expect(new Headers(init.headers).get("xi-api-key")).toBe(
        "synthetic-eleven",
      );
      expect(new Headers(init.headers).has("api-subscription-key")).toBe(false);
      expect(JSON.parse(String(init.body))).toEqual({
        text: "தமிழ் test",
        model_id: "eleven_v3",
        language_code: "ta",
      });
      return new Response(pcm, { headers: { "content-type": "audio/pcm" } });
    },
  });
  const audio = await tts.synthesize(input());
  expect(audio.mimeType).toBe("audio/wav");
  expect(audio.bytes.slice(44)).toEqual(pcm);
  expect(inspectPcmWav(audio.bytes).sampleRate).toBe(24000);
  expect(audio.durationMs).toBe(167);
});

test("disabled, consent, text/locale limits, unreviewed models and path-like voices cannot cause HTTP", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({});
  };
  await expect(
    createSarvamTts({ model: "bulbul:v3", voice: "shubh", fetch }).synthesize(
      input(),
    ),
  ).rejects.toThrow("disabled");
  expect(() =>
    createElevenLabsTts({ model: "unreviewed", voice: "voice", fetch }),
  ).toThrow("model");
  expect(() =>
    createElevenLabsTts({ model: "eleven_v3", voice: "../other", fetch }),
  ).toThrow("voice");
  const tts = createSarvamTts({
    model: "bulbul:v3",
    voice: "shubh",
    apiKey: "synthetic",
    allowLiveRequests: true,
    fetch,
  });
  await expect(
    tts.synthesize({ ...input(), consentToProcess: false } as never),
  ).rejects.toThrow("consent");
  await expect(
    tts.synthesize({ ...input(), text: "x".repeat(501) }),
  ).rejects.toThrow("500");
  await expect(
    tts.synthesize({ ...input(), language: "kn-IN" }),
  ).rejects.toThrow("language");
  expect(calls).toBe(0);
});

test("bad base64, multiple audio files, fake WAV and malformed PCM fail without retries", async () => {
  for (const audios of [
    ["%%%"],
    ["AA==", "AA=="],
    [Buffer.from(new Uint8Array(100)).toString("base64")],
  ]) {
    let calls = 0;
    const tts = createSarvamTts({
      model: "bulbul:v3",
      voice: "shubh",
      apiKey: "synthetic",
      allowLiveRequests: true,
      fetch: async () => {
        calls++;
        return Response.json({ audios });
      },
    });
    await expect(tts.synthesize(input())).rejects.toMatchObject({
      status: 502,
    });
    expect(calls).toBe(1);
  }
  const tts = createElevenLabsTts({
    model: "eleven_v3",
    voice: "voice",
    apiKey: "synthetic",
    allowLiveRequests: true,
    fetch: async () =>
      new Response(new Uint8Array(3), {
        headers: { "content-type": "application/octet-stream" },
      }),
  });
  await expect(tts.synthesize(input())).rejects.toMatchObject({ status: 502 });
});

test("provider errors, byte budgets and unsupported binary formats fail once without retention fallback", async () => {
  for (const response of [
    new Response("synthetic-private-provider-error", { status: 403 }),
    new Response("synthetic-private-provider-error", { status: 429 }),
    new Response(new Uint8Array(2_000_000), {
      headers: { "content-type": "audio/pcm" },
    }),
    new Response(new Uint8Array(2), {
      headers: { "content-type": "audio/pcm", "content-length": "2000000" },
    }),
    new Response(new Uint8Array(100), {
      headers: { "content-type": "audio/L16" },
    }),
    new Response(new Uint8Array(100), {
      headers: { "content-type": "audio/mpeg" },
    }),
  ]) {
    let calls = 0;
    const tts = createElevenLabsTts({
      model: "eleven_v3",
      voice: "voice",
      apiKey: "synthetic-key",
      allowLiveRequests: true,
      fetch: async (url) => {
        calls++;
        expect(url.endsWith("enable_logging=false")).toBe(true);
        return response;
      },
    });
    const error = await tts
      .synthesize(input())
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("synthetic-private-provider-error");
    expect(String(error)).not.toContain("synthetic-key");
    expect(calls).toBe(1);
  }
  for (const response of [
    new Response("x".repeat(2_700_001), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", {
      headers: { "content-type": "application/json-fake" },
    }),
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const tts = createSarvamTts({
      model: "bulbul:v3",
      voice: "shubh",
      apiKey: "synthetic",
      allowLiveRequests: true,
      fetch: async () => response,
    });
    await expect(tts.synthesize(input())).rejects.toMatchObject({
      status: 502,
    });
  }
});

test("binary TTS cancellation cancels the reader and deadline/immediate abort never retries", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
    },
    cancel() {
      cancelled = true;
    },
  });
  const tts = createElevenLabsTts({
    model: "eleven_v3",
    voice: "voice",
    apiKey: "synthetic",
    allowLiveRequests: true,
    fetch: async () =>
      new Response(body, { headers: { "content-type": "audio/pcm" } }),
  });
  const controller = new AbortController();
  const result = tts.synthesize({ ...input(), signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(result).rejects.toMatchObject({ status: 408 });
  expect(cancelled).toBe(true);
  let calls = 0,
    aborts = 0;
  const hanging = createElevenLabsTts({
    model: "eleven_v3",
    voice: "voice",
    apiKey: "synthetic",
    allowLiveRequests: true,
    timeoutMs: 1000,
    fetch: async (_url, init) => {
      calls++;
      init.signal?.addEventListener("abort", () => aborts++);
      return new Promise<Response>(() => {});
    },
  });
  await expect(hanging.synthesize(input())).rejects.toMatchObject({
    status: 504,
  });
  expect(calls).toBe(1);
  expect(aborts).toBe(1);
  const pre = new AbortController();
  pre.abort();
  await expect(
    hanging.synthesize({ ...input(), signal: pre.signal }),
  ).rejects.toMatchObject({ status: 408 });
  const immediate = new AbortController();
  const stopped = hanging.synthesize({ ...input(), signal: immediate.signal });
  immediate.abort();
  await expect(stopped).rejects.toMatchObject({ status: 408 });
  expect(calls).toBe(1);
});

test("explicit Indic locale and logging options remain per-provider, not proof of generated speech quality", async () => {
  expect(() =>
    createSarvamTts({
      model: "bulbul:v3",
      voice: "shubh",
      providerLogging: "deny",
    }),
  ).toThrow("retention");
  const tts = createElevenLabsTts({
    model: "eleven_v3",
    voice: "voice",
    apiKey: "synthetic",
    allowLiveRequests: true,
    languages: ["ml-IN", "kn-IN"],
    providerLogging: "allow",
    fetch: async (url, init) => {
      expect(url.endsWith("enable_logging=true")).toBe(true);
      expect(JSON.parse(String(init.body)).language_code).toBe("ml");
      return new Response(new Uint8Array(480), {
        headers: { "content-type": "application/octet-stream" },
      });
    },
  });
  const result = await tts.synthesize({ ...input(), language: "ml-IN" });
  expect(result.language).toBe("ml-IN");
  expect(result.durationMs).toBe(10);
  expect(result.warnings.join(" ")).toContain("not independent quality");
  await expect(
    createElevenLabsTts({
      model: "eleven_v3",
      voice: "voice",
      allowLiveRequests: true,
    }).synthesize(input()),
  ).rejects.toMatchObject({ status: 503 });
});
