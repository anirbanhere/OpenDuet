import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import {
  fixtureLanguages,
  type ProviderRoles,
  type SpeechLanguage,
  speechLanguages,
} from "./roles";

const language = z.enum(speechLanguages),
  audioBytes = z
    .instanceof(Uint8Array)
    .refine((value) => value.length >= 44 && value.length <= 2_000_000);
const source = z
  .object({
    mode: z.enum(["fixture", "live"]),
    provider: z.string().min(1).max(50),
    model: z.string().min(1).max(150),
  })
  .strict();
const transcriptSchema = z
  .object({
    text: z.string().min(1).max(2000),
    language,
    confidence: z.number().min(0).max(1).nullable(),
    alternatives: z.array(z.string().max(2000)).max(3),
    warnings: z.array(z.string().max(300)).max(8),
    source,
  })
  .strict();
const audioSchema = z
  .object({
    bytes: audioBytes,
    mimeType: z.literal("audio/wav"),
    language,
    durationMs: z.number().int().min(1).max(60000),
    isSpeech: z.boolean(),
    warnings: z.array(z.string().max(300)).max(8),
    source,
  })
  .strict();
const sttRequest = z
  .object({
    audio: audioBytes,
    mimeType: z.literal("audio/wav"),
    languageHint: language.nullish(),
    consentToProcess: z.literal(true),
  })
  .strict();
const ttsRequest = z
  .object({
    text: z.string().trim().min(1).max(2000),
    language,
    consentToProcess: z.literal(true),
  })
  .strict();
export type Transcript = z.infer<typeof transcriptSchema>;
export type SpeechAudio = z.infer<typeof audioSchema>;
export type SttRequest = z.infer<typeof sttRequest> & { signal: AbortSignal };
export type TtsRequest = z.infer<typeof ttsRequest> & { signal: AbortSignal };
export interface SpeechToTextProvider {
  transcribe(input: SttRequest): Promise<Transcript>;
}
export interface TextToSpeechProvider {
  synthesize(input: TtsRequest): Promise<SpeechAudio>;
}
type FixtureId = "fixture-a" | "fixture-b";
type Adapters = {
  stt?: ReadonlyMap<FixtureId, SpeechToTextProvider>;
  tts?: ReadonlyMap<FixtureId, TextToSpeechProvider>;
};
const texts = {
  "en-IN": "Please help me plan a demo dental appointment.",
  "hi-IN": "कृपया डेमो दंत अपॉइंटमेंट की योजना बनाने में मदद करें।",
  "ta-IN": "டெமோ பல் மருத்துவ சந்திப்பைத் திட்டமிட உதவுங்கள்.",
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** An audible test tone, not a recording or natural TTS. No private audio/files are read. */
function tone(frequency: number) {
  const samples = 4000,
    bytes = new Uint8Array(44 + samples * 2),
    view = new DataView(bytes.buffer),
    write = (at: number, text: string) =>
      bytes.set(new TextEncoder().encode(text), at);
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((2 * Math.PI * frequency * i) / 16000) * 2500),
      true,
    );
  return bytes;
}
export function syntheticSpeechFixture(
  locale: (typeof fixtureLanguages)[number],
) {
  const index = fixtureLanguages.indexOf(locale);
  if (index < 0)
    throw new LocalError("Synthetic fixture language unavailable.");
  return {
    audio: tone(440 + index * 220),
    text: texts[locale],
    language: locale,
    mode: "fixture" as const,
    isRecording: false,
  };
}
const fixtures = new Map(
  fixtureLanguages.map((language) => {
    const fixture = syntheticSpeechFixture(language);
    return [digest(fixture.audio), fixture] as const;
  }),
);
const fixtureStt = (provider: FixtureId): SpeechToTextProvider => ({
  transcribe: async (input) => {
    const fixture = fixtures.get(digest(input.audio));
    if (!fixture)
      throw new LocalError(
        "Audio is not a known synthetic fixture. This adapter is not real ASR.",
      );
    return {
      text: fixture.text,
      language: fixture.language,
      confidence: null,
      alternatives: [],
      warnings: [
        "Synthetic tone lookup only; not speech recognition.",
        ...(input.languageHint && input.languageHint !== fixture.language
          ? ["The language hint differs from the synthetic fixture evidence."]
          : []),
      ],
      source: { mode: "fixture", provider, model: "synthetic-stt-v1" },
    };
  },
});
const fixtureTts = (provider: FixtureId): TextToSpeechProvider => ({
  synthesize: async (input) => ({
    bytes: tone(
      (provider === "fixture-a" ? 1400 : 1800) +
        fixtureLanguages.indexOf(
          input.language as (typeof fixtureLanguages)[number],
        ) *
          100,
    ),
    mimeType: "audio/wav",
    language: input.language,
    durationMs: 250,
    isSpeech: false,
    warnings: ["Generated test tone only; the requested text is not spoken."],
    source: { mode: "fixture", provider, model: "synthetic-tone-v1" },
  }),
});
const defaultStt = new Map<FixtureId, SpeechToTextProvider>([
    ["fixture-a", fixtureStt("fixture-a")],
    ["fixture-b", fixtureStt("fixture-b")],
  ]),
  defaultTts = new Map<FixtureId, TextToSpeechProvider>([
    ["fixture-a", fixtureTts("fixture-a")],
    ["fixture-b", fixtureTts("fixture-b")],
  ]);
async function deadline<T>(
  milliseconds: number,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new LocalError(
              "Speech adapter timed out; no retry or fallback.",
              504,
            ),
          );
        }, milliseconds);
      }),
    ]);
  } catch (error) {
    if (error instanceof LocalError) throw error;
    throw new LocalError("Speech adapter failed; no retry or fallback.", 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function selected(
  profile: ProviderRoles["stt"],
  locale?: SpeechLanguage | null,
): FixtureId {
  if (profile.provider === "disabled")
    throw new LocalError("This speech role is disabled.", 503);
  if (profile.provider !== "fixture-a" && profile.provider !== "fixture-b")
    throw new LocalError(
      "This live speech adapter is not connected. Configuration alone does not enable it.",
      503,
    );
  if (
    locale &&
    (!profile.languages.includes(locale) ||
      !(fixtureLanguages as readonly string[]).includes(locale))
  )
    throw new LocalError(
      "This speech language is unavailable in the selected fixture adapter.",
    );
  return profile.provider;
}
export function createSpeech(roles: ProviderRoles, adapters: Adapters = {}) {
  return {
    async transcribe(input: unknown): Promise<Transcript> {
      const parsed = sttRequest.safeParse(input);
      if (!parsed.success) {
        const needsConsent = parsed.error.issues.some(
          (issue) => issue.path[0] === "consentToProcess",
        );
        throw new LocalError(
          needsConsent
            ? "Explicit consent is required for speech processing."
            : "Speech input requires bounded valid WAV audio and language fields.",
          needsConsent ? 403 : 422,
        );
      }
      const provider = selected(roles.stt, parsed.data.languageHint),
        adapter = (adapters.stt ?? defaultStt).get(provider);
      if (!adapter)
        throw new LocalError("Selected STT adapter unavailable.", 503);
      const raw = await deadline(roles.stt.timeoutMs, (signal) =>
          adapter.transcribe({
            ...parsed.data,
            audio: parsed.data.audio.slice(),
            signal,
          }),
        ),
        result = transcriptSchema.safeParse(raw);
      if (!result.success)
        throw new LocalError(
          "The STT adapter returned an invalid transcript.",
          502,
        );
      selected(roles.stt, result.data.language);
      if (
        result.data.source.provider !== provider ||
        result.data.source.model !== roles.stt.model ||
        result.data.source.mode !== "fixture" ||
        result.data.confidence !== null
      )
        throw new LocalError(
          "STT fixture identity or evidence mode is invalid.",
          502,
        );
      return result.data;
    },
    async synthesize(input: unknown): Promise<SpeechAudio> {
      const parsed = ttsRequest.safeParse(input);
      if (!parsed.success) {
        const needsConsent = parsed.error.issues.some(
          (issue) => issue.path[0] === "consentToProcess",
        );
        throw new LocalError(
          needsConsent
            ? "Explicit consent is required for speech processing."
            : "Speech output requires bounded valid text and language fields.",
          needsConsent ? 403 : 422,
        );
      }
      const provider = selected(roles.tts, parsed.data.language),
        adapter = (adapters.tts ?? defaultTts).get(provider);
      if (!adapter)
        throw new LocalError("Selected TTS adapter unavailable.", 503);
      const raw = await deadline(roles.tts.timeoutMs, (signal) =>
          adapter.synthesize({ ...parsed.data, signal }),
        ),
        result = audioSchema.safeParse(raw);
      if (!result.success)
        throw new LocalError("The TTS adapter returned invalid audio.", 502);
      if (
        result.data.source.provider !== provider ||
        result.data.source.model !== roles.tts.model ||
        result.data.source.mode !== "fixture" ||
        result.data.isSpeech ||
        result.data.language !== parsed.data.language
      )
        throw new LocalError(
          "TTS fixture identity or evidence mode is invalid.",
          502,
        );
      return result.data;
    },
  };
}
