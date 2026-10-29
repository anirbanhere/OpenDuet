import { z } from "zod";
import { LocalError } from "./errors";
import type { ProviderFetch } from "./http-json";
import {
  fixtureLanguages,
  type SpeechLanguage,
  speechLanguages,
} from "./roles";
import {
  parseTtsInput,
  type SpeechAudio,
  type TextToSpeechProvider,
} from "./speech";
import { speechBytes, speechJson } from "./speech-http";
import { inspectPcmWav, pcm16ToWav } from "./wav";

type Options = {
  model: string;
  /** Operator-selected voice with appropriate authorization; this factory grants none. */
  voice: string;
  apiKey?: string;
  allowLiveRequests?: boolean;
  timeoutMs?: number;
  languages?: readonly SpeechLanguage[];
  fetch?: ProviderFetch;
  providerLogging?: "deny" | "allow";
};
const iso: Record<SpeechLanguage, string> = {
  "en-IN": "en",
  "hi-IN": "hi",
  "ta-IN": "ta",
  "ml-IN": "ml",
  "kn-IN": "kn",
};
const sarvamAudio = z.object({
  audios: z.array(z.string().min(4).max(2_666_668)).length(1),
});
const invalidAudio = () =>
  new LocalError("Speech provider returned invalid or oversized audio.", 502);

function decodeWav(response: unknown) {
  const result = sarvamAudio.safeParse(response);
  if (!result.success) throw invalidAudio();
  const encoded = result.data.audios[0];
  if (!encoded) throw invalidAudio();
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw invalidAudio();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 2_000_000 || bytes.toString("base64") !== encoded)
    throw invalidAudio();
  return new Uint8Array(bytes);
}

/** Unregistered vendor factories. No media upload, message delivery or voice cloning. */
function createTts(
  provider: "sarvam" | "elevenlabs",
  options: Options,
): TextToSpeechProvider {
  const model = options.model,
    voice = options.voice;
  if (model !== (provider === "sarvam" ? "bulbul:v3" : "eleven_v3"))
    throw new LocalError("Unsupported speech provider model.");
  if (typeof voice !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(voice))
    throw new LocalError("Select an explicit authorized speech voice ID.");
  if (provider === "sarvam" && options.providerLogging !== undefined)
    throw new LocalError(
      "No Sarvam retention-control option has been verified.",
    );
  if (
    options.providerLogging !== undefined &&
    !["deny", "allow"].includes(options.providerLogging)
  )
    throw new LocalError("Unsupported speech retention policy.");
  const languages = z
    .array(z.enum(speechLanguages))
    .min(1)
    .max(5)
    .parse([...(options.languages ?? fixtureLanguages)]);
  const timeout = options.timeoutMs ?? 20000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000)
    throw new LocalError("Unsupported speech timeout budget.");
  const key = options.apiKey?.trim(),
    enabled = options.allowLiveRequests === true,
    logging = options.providerLogging ?? "deny",
    call = options.fetch ?? fetch;
  return {
    async synthesize(input): Promise<SpeechAudio> {
      if (!enabled)
        throw new LocalError("This live speech adapter is disabled.", 503);
      if (!key || key.length > 1000 || /[\r\n]/.test(key))
        throw new LocalError(
          "Configure this speech provider's server key.",
          503,
        );
      if (!input || !(input.signal instanceof AbortSignal))
        throw new LocalError("Speech requires a valid cancellation signal.");
      if (input.signal.aborted)
        throw new LocalError("Speech request was aborted.", 408);
      const { signal, ...raw } = input,
        parsed = parseTtsInput(raw);
      if (!languages.includes(parsed.language))
        throw new LocalError("Selected speech language is not enabled.");
      if (parsed.text.length > 500)
        throw new LocalError(
          "Vendor TTS accepts at most 500 text characters in this slice.",
        );
      let bytes: Uint8Array<ArrayBuffer>;
      if (provider === "sarvam") {
        const response = await speechJson(
          call,
          "https://api.sarvam.ai/text-to-speech",
          {
            method: "POST",
            headers: {
              "api-subscription-key": key,
              "content-type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              text: parsed.text,
              language_code: parsed.language,
              model,
              speaker: voice,
              speech_sample_rate: 24000,
              output_audio_codec: "wav",
            }),
          },
          signal,
          timeout,
          2_700_000,
        );
        bytes = decodeWav(response);
      } else {
        const pcm = await speechBytes(
          call,
          `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000&enable_logging=${logging === "allow"}`,
          {
            method: "POST",
            headers: {
              "xi-api-key": key,
              "content-type": "application/json",
              Accept: "audio/pcm",
            },
            body: JSON.stringify({
              text: parsed.text,
              model_id: model,
              language_code: iso[parsed.language],
            }),
          },
          signal,
          timeout,
          1_999_956,
          ["audio/pcm", "application/octet-stream"],
        );
        try {
          bytes = pcm16ToWav(pcm, 24000);
        } catch {
          throw invalidAudio();
        }
      }
      let metadata: ReturnType<typeof inspectPcmWav>;
      try {
        metadata = inspectPcmWav(bytes);
      } catch {
        throw invalidAudio();
      }
      if (signal.aborted)
        throw new LocalError("Speech request was aborted.", 408);
      return {
        bytes,
        mimeType: "audio/wav",
        language: parsed.language,
        durationMs: Math.ceil(metadata.durationMs),
        isSpeech: true,
        source: { mode: "live", provider, model },
        warnings: [
          "Provider-generated audio; verify playback, language and critical names, dates and amounts.",
          "Provider processing/retention terms apply; requested voice and locale are not independent quality or identity evidence.",
        ],
      };
    },
  };
}
export const createSarvamTts = (options: Options) =>
  createTts("sarvam", options);
export const createElevenLabsTts = (options: Options) =>
  createTts("elevenlabs", options);
