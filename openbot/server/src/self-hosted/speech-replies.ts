import { z } from "zod";
import { LocalError } from "./errors";
import {
  type ProviderRoles,
  type SpeechLanguage,
  speechLanguages,
} from "./roles";
import {
  parseSpeechAudio,
  type SpeechAudio,
  type TextToSpeechProvider,
  withSpeechDeadline,
} from "./speech";

const inputSchema = z
  .object({
    policy: z.enum(["text_only", "voice_only", "text_and_voice"]),
    text: z.string().trim().min(1).max(2000),
    language: z.enum(speechLanguages),
    consentToProcess: z.boolean().optional().default(false),
    signal: z.instanceof(AbortSignal),
  })
  .strict();
export type SpeechReplyPolicy = z.infer<typeof inputSchema>["policy"];
export type SpeechReply = {
  policy: SpeechReplyPolicy;
  language: SpeechLanguage;
  text: string | null;
  audio: SpeechAudio | null;
  status:
    | "text_ready"
    | "voice_ready"
    | "requires_consent"
    | "unavailable"
    | "fixture_only";
  reason:
    | null
    | "consent_required"
    | "role_disabled"
    | "adapter_missing"
    | "language_unavailable"
    | "text_too_long"
    | "tts_failed"
    | "tts_timeout"
    | "invalid_audio"
    | "synthetic_tone";
  warnings: string[];
};

/** Composition only: one injected TTS call at most, no storage/channel or delivery claim. */
export function createSpeechReplies(
  role: ProviderRoles["tts"],
  adapter?: TextToSpeechProvider,
) {
  const { provider, model, timeoutMs } = role,
    languages = [...role.languages];
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    throw new LocalError("Unsupported speech timeout budget.");
  const fixture = provider === "fixture-a" || provider === "fixture-b";
  return {
    async compose(input: unknown): Promise<SpeechReply> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success)
        throw new LocalError(
          "Use a valid response policy, bounded text, locale, boolean consent and cancellation signal.",
        );
      const request = parsed.data,
        { signal } = request;
      if (signal.aborted)
        throw new LocalError("Speech request was aborted.", 408);
      const base = {
        policy: request.policy,
        language: request.language,
        text: request.policy === "voice_only" ? null : request.text,
        audio: null,
        warnings: [],
      };
      if (request.policy === "text_only")
        return { ...base, status: "text_ready", reason: null };
      if (!request.consentToProcess)
        return {
          ...base,
          status: "requires_consent",
          reason: "consent_required",
        };
      const unavailable = (reason: SpeechReply["reason"]): SpeechReply => ({
        ...base,
        status: "unavailable",
        reason,
        warnings: [
          "Requested voice is unavailable; no voice message was delivered.",
        ],
      });
      if (!model || provider === "disabled" || provider === "local-whisper")
        return unavailable("role_disabled");
      if (!adapter) return unavailable("adapter_missing");
      if (!languages.includes(request.language))
        return unavailable("language_unavailable");
      if (request.text.length > 500) return unavailable("text_too_long");
      let raw: unknown;
      try {
        raw = await withSpeechDeadline(
          timeoutMs,
          (child) =>
            adapter.synthesize({
              text: request.text,
              language: request.language,
              consentToProcess: true,
              signal: child,
            }),
          signal,
        );
      } catch (error) {
        if (signal.aborted)
          throw new LocalError("Speech request was aborted.", 408);
        return unavailable(
          error instanceof LocalError && error.status === 504
            ? "tts_timeout"
            : "tts_failed",
        );
      }
      if (signal.aborted)
        throw new LocalError("Speech request was aborted.", 408);
      let audio: SpeechAudio;
      try {
        audio = parseSpeechAudio(raw);
      } catch {
        return unavailable("invalid_audio");
      }
      if (
        audio.language !== request.language ||
        audio.source.provider !== provider ||
        audio.source.model !== model ||
        audio.source.mode !== (fixture ? "fixture" : "live") ||
        audio.isSpeech === fixture
      )
        return unavailable("invalid_audio");
      if (fixture)
        return {
          ...base,
          status: "fixture_only",
          reason: "synthetic_tone",
          warnings: [
            "Synthetic fixture tone only; no spoken reply or voice message was delivered.",
          ],
        };
      return {
        ...base,
        audio,
        status: "voice_ready",
        reason: null,
        warnings: [
          "Composed audio is not a delivered message. Verify spoken content, language and critical fields.",
        ],
      };
    },
  };
}
