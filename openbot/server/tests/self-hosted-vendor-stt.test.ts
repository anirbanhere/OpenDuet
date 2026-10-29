import { expect, test } from "bun:test";
import { LocalError } from "../src/self-hosted/errors";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import {
  createElevenLabsStt,
  createSarvamStt,
} from "../src/self-hosted/vendor-stt";

const input = () => ({
  audio: syntheticSpeechFixture("ta-IN").audio,
  mimeType: "audio/wav" as const,
  languageHint: "ta-IN" as const,
  consentToProcess: true as const,
  signal: new AbortController().signal,
});
test("Sarvam sends only its key and fixed multipart contract; language probability is not transcript confidence", async () => {
  let calls = 0;
  const stt = createSarvamStt({
    model: "saaras:v3",
    apiKey: "synthetic-sarvam-key",
    allowLiveRequests: true,
    fetch: async (url, init) => {
      calls++;
      expect(url).toBe("https://api.sarvam.ai/speech-to-text");
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      expect(headers.get("api-subscription-key")).toBe("synthetic-sarvam-key");
      expect(headers.has("xi-api-key")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("content-type")).toBe(false);
      const form = init.body as FormData;
      expect(form.get("model")).toBe("saaras:v3");
      expect(form.get("mode")).toBe("transcribe");
      expect(form.get("language_code")).toBe("ta-IN");
      const file = form.get("file") as File;
      expect(file.name).toBe("speech.wav");
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(input().audio);
      return Response.json({
        transcript: "சோதனை test",
        language_code: "ta-IN",
        language_probability: 0.99,
        request_id: "synthetic",
      });
    },
  });
  const result = await stt.transcribe(input());
  expect(result.text).toBe("சோதனை test");
  expect(result.language).toBe("ta-IN");
  expect(result.confidence).toBeNull();
  expect(result.source).toEqual({
    mode: "live",
    provider: "sarvam",
    model: "saaras:v3",
  });
  expect(JSON.stringify(result)).not.toContain("synthetic-sarvam-key");
  expect(calls).toBe(1);
});

test("ElevenLabs uses ISO language mapping and explicit retention intent without extra transcript editing or webhooks", async () => {
  const stt = createElevenLabsStt({
    model: "scribe_v2",
    apiKey: "synthetic-eleven-key",
    allowLiveRequests: true,
    fetch: async (url, init) => {
      expect(url).toBe(
        "https://api.elevenlabs.io/v1/speech-to-text?enable_logging=false",
      );
      const headers = new Headers(init.headers);
      expect(headers.get("xi-api-key")).toBe("synthetic-eleven-key");
      expect(headers.has("api-subscription-key")).toBe(false);
      const form = init.body as FormData;
      expect(form.get("model_id")).toBe("scribe_v2");
      expect(form.get("language_code")).toBe("tam");
      expect(form.get("diarize")).toBe("false");
      expect(form.get("tag_audio_events")).toBe("false");
      expect(form.get("timestamps_granularity")).toBe("none");
      expect(form.get("webhook")).toBe("false");
      expect(form.get("use_multi_channel")).toBe("false");
      expect(form.has("transcript_edit")).toBe(false);
      return Response.json({
        text: "नमस्ते test",
        language_code: "hin",
        language_probability: 0.999,
      });
    },
  });
  const result = await stt.transcribe(input());
  expect(result.language).toBe("hi-IN");
  expect(result.confidence).toBeNull();
  expect(result.warnings.some((item) => item.includes("hint"))).toBe(true);
});

test("disabled, missing-key, invalid-model/consent/WAV and unsupported locale are rejected before HTTP", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({});
  };
  await expect(
    createSarvamStt({ model: "saaras:v4", fetch }).transcribe(input()),
  ).rejects.toThrow("disabled");
  await expect(
    createSarvamStt({
      model: "saaras:v4",
      allowLiveRequests: true,
      fetch,
    }).transcribe(input()),
  ).rejects.toThrow("key");
  expect(() => createSarvamStt({ model: "unreviewed", fetch })).toThrow(
    "model",
  );
  const stt = createSarvamStt({
    model: "saaras:v4",
    allowLiveRequests: true,
    apiKey: "synthetic",
    fetch,
  });
  await expect(
    stt.transcribe({ ...input(), consentToProcess: false } as never),
  ).rejects.toThrow("consent");
  await expect(
    stt.transcribe({ ...input(), audio: new Uint8Array(100) }),
  ).rejects.toThrow("WAV");
  await expect(
    stt.transcribe({ ...input(), languageHint: "ml-IN" }),
  ).rejects.toThrow("language");
  const tooLong = new Uint8Array(44 + 16000 * 2 * 30);
  tooLong.set(input().audio.slice(0, 44));
  const view = new DataView(tooLong.buffer);
  view.setUint32(4, tooLong.length - 8, true);
  view.setUint32(40, tooLong.length - 44, true);
  await expect(stt.transcribe({ ...input(), audio: tooLong })).rejects.toThrow(
    "29 seconds",
  );
  await expect(
    stt.transcribe({
      ...input(),
      source_url: "http://169.254.169.254/",
    } as never),
  ).rejects.toThrow("Speech input");
  expect(calls).toBe(0);
});

test("provider failures and malformed/oversized output are sanitized and never retried", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const stt = createSarvamStt({
      model: "saaras:v4",
      allowLiveRequests: true,
      apiKey: "synthetic",
      fetch: async () => {
        calls++;
        return new Response("synthetic-private-error", { status });
      },
    });
    const error = await stt.transcribe(input()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(LocalError);
    expect(String(error)).not.toContain("synthetic-private-error");
    expect(calls).toBe(1);
  }
  for (const response of [
    Response.json({ transcript: "Synthetic", language_code: null }),
    Response.json({ transcript: "x".repeat(2001), language_code: "ta-IN" }),
    new Response("{".repeat(130000), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const stt = createSarvamStt({
      model: "saaras:v4",
      allowLiveRequests: true,
      apiKey: "synthetic",
      fetch: async () => response,
    });
    await expect(stt.transcribe(input())).rejects.toThrow();
  }
});

test("deadline and parent cancellation abort once without fallback, including a transport that ignores abort", async () => {
  let calls = 0,
    aborts = 0;
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    calls++;
    init.signal?.addEventListener("abort", () => aborts++);
    return new Promise(() => {});
  };
  const stt = createSarvamStt({
    model: "saaras:v4",
    allowLiveRequests: true,
    apiKey: "synthetic",
    timeoutMs: 1000,
    fetch,
  });
  await expect(stt.transcribe(input())).rejects.toMatchObject({ status: 504 });
  expect(calls).toBe(1);
  expect(aborts).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    stt.transcribe({ ...input(), signal: controller.signal }),
  ).rejects.toMatchObject({ status: 408 });
  expect(calls).toBe(1);
  const active = new AbortController();
  const result = stt.transcribe({ ...input(), signal: active.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  active.abort();
  await expect(result).rejects.toMatchObject({ status: 408 });
  expect(calls).toBe(2);
  expect(aborts).toBe(2);
  const immediate = new AbortController();
  const cancelled = stt.transcribe({ ...input(), signal: immediate.signal });
  immediate.abort();
  await expect(cancelled).rejects.toMatchObject({ status: 408 });
  expect(calls).toBe(2);
});

test("v4 auto language and explicitly enabled Indic locales preserve provider evidence without a guessed hint", async () => {
  const stt = createSarvamStt({
    model: "saaras:v4",
    apiKey: "synthetic",
    allowLiveRequests: true,
    languages: ["ml-IN", "kn-IN"],
    fetch: async (_url, init) => {
      const form = init.body as FormData;
      expect(form.has("mode")).toBe(false);
      expect(form.get("language_code")).toBe("unknown");
      return Response.json({
        transcript: "കൃത്രിമ test",
        language_code: "ml-IN",
      });
    },
  });
  expect(
    (await stt.transcribe({ ...input(), languageHint: undefined })).language,
  ).toBe("ml-IN");
  const eleven = createElevenLabsStt({
    model: "scribe_v2",
    apiKey: "synthetic",
    allowLiveRequests: true,
    providerLogging: "allow",
    languages: ["kn-IN"],
    fetch: async (url, init) => {
      expect(url.endsWith("enable_logging=true")).toBe(true);
      expect((init.body as FormData).get("language_code")).toBe("kan");
      return Response.json({ text: "ಕೃತಕ test", language_code: "kn" });
    },
  });
  expect(
    (await eleven.transcribe({ ...input(), languageHint: "kn-IN" })).language,
  ).toBe("kn-IN");
});

test("aborting during a streamed JSON body cancels its reader and never returns a partial transcript", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"transcript":"unfinished'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const stt = createSarvamStt({
    model: "saaras:v4",
    apiKey: "synthetic",
    allowLiveRequests: true,
    fetch: async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  });
  const controller = new AbortController();
  const result = stt.transcribe({ ...input(), signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await expect(result).rejects.toMatchObject({ status: 408 });
  expect(cancelled).toBe(true);
});
