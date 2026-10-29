import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";

export const speechLanguages = [
  "en-IN",
  "hi-IN",
  "ta-IN",
  "ml-IN",
  "kn-IN",
] as const;
export type SpeechLanguage = (typeof speechLanguages)[number];
export const fixtureLanguages = ["en-IN", "hi-IN", "ta-IN"] as const;
const provider = z.enum([
  "disabled",
  "fixture-a",
  "fixture-b",
  "sarvam",
  "elevenlabs",
  "local-whisper",
]);
export type SpeechProvider = z.infer<typeof provider>;
export type ModelPurpose = "reasoning" | "conversation" | "extraction";
export type ModelRole = {
  id: string;
  provider: "meta" | "openrouter";
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  attempts: 1;
  fallbacks: [];
};
export type SpeechRole = {
  provider: SpeechProvider;
  model: string | null;
  languages: SpeechLanguage[];
  timeoutMs: number;
};
type ReadonlyTree<T> = T extends object
  ? { readonly [K in keyof T]: ReadonlyTree<T[K]> }
  : T;
type Bundle = {
  reasoning: ModelRole;
  conversation: ModelRole;
  extraction: ModelRole | null;
  stt: SpeechRole;
  tts: SpeechRole;
  revision: string;
};
export type ProviderRoles = ReadonlyTree<Bundle>;
type Policy = {
  model: string;
  allowPaid: boolean;
  metaEnabled: boolean;
  metaModels: readonly string[];
};
const modelId = /^[A-Za-z0-9_./:-]{1,150}$/;
function freeze<T>(value: T): ReadonlyTree<T> {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value as ReadonlyTree<T>;
}

/** Only role settings are copied. Provider credentials never become role snapshots/diagnostics. */
export function configureRoles(
  env: Readonly<Record<string, string | undefined>>,
  policy: Policy,
): ProviderRoles {
  const count = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name]?.trim() || fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new LocalError(`${name} exceeds the supported role budget.`);
    return value;
  };
  const model = (role: ModelPurpose): ModelRole | null => {
    const prefix = `SAATHI_${role.toUpperCase()}`,
      ref =
        env[`${prefix}_MODEL`]?.trim() ||
        (role === "extraction" ? "disabled" : `openrouter:${policy.model}`);
    if (ref === "disabled" && role === "extraction") return null;
    const at = ref.indexOf(":"),
      provider = ref.slice(0, at),
      id = ref.slice(at + 1);
    if ((provider !== "meta" && provider !== "openrouter") || !modelId.test(id))
      throw new LocalError(
        `${prefix}_MODEL must be a supported provider:model reference.`,
      );
    if (
      provider === "meta" &&
      (!policy.metaEnabled || !policy.metaModels.includes(id))
    )
      throw new LocalError(`The ${role} Meta model is not explicitly enabled.`);
    if (
      provider === "openrouter" &&
      !policy.allowPaid &&
      id !== "openrouter/free" &&
      !id.endsWith(":free")
    )
      throw new LocalError(`Paid ${role} inference is disabled.`);
    return {
      id: ref,
      provider,
      model: id,
      timeoutMs: count(`${prefix}_TIMEOUT_MS`, 60000, 1000, 60000),
      maxOutputTokens: count(`${prefix}_MAX_OUTPUT_TOKENS`, 2048, 128, 4096),
      attempts: 1,
      fallbacks: [],
    };
  };
  const speech = (kind: "stt" | "tts"): SpeechRole => {
    const prefix = `SAATHI_${kind.toUpperCase()}`,
      parsed = provider.safeParse(
        env[`${prefix}_PROVIDER`]?.trim() || "disabled",
      );
    if (!parsed.success)
      throw new LocalError(`${prefix}_PROVIDER is unsupported.`);
    const selected = parsed.data,
      fixture = selected.startsWith("fixture-"),
      fixtureModel = kind === "stt" ? "synthetic-stt-v1" : "synthetic-tone-v1";
    const id =
      env[`${prefix}_MODEL`]?.trim() || (fixture ? fixtureModel : null);
    if (selected !== "disabled" && (!id || !modelId.test(id)))
      throw new LocalError(
        `Configure a valid ${prefix}_MODEL; a provider name alone does not select a model.`,
      );
    if (fixture && id !== fixtureModel)
      throw new LocalError(
        `The ${kind} fixture adapter only supports its synthetic model.`,
      );
    const languages = [
      ...new Set(
        (env[`${prefix}_LANGUAGES`]?.trim() || fixtureLanguages.join(","))
          .split(",")
          .map((value) => value.trim()),
      ),
    ];
    const list = z
      .array(z.enum(speechLanguages))
      .min(1)
      .max(5)
      .safeParse(languages);
    if (!list.success)
      throw new LocalError(
        `${prefix}_LANGUAGES contains unsupported language settings.`,
      );
    if (
      fixture &&
      list.data.some(
        (language) =>
          !(fixtureLanguages as readonly string[]).includes(language),
      )
    )
      throw new LocalError(
        `The ${kind} fixture adapter does not support every requested language.`,
      );
    return {
      provider: selected,
      model: selected === "disabled" ? null : id,
      languages: list.data,
      timeoutMs: count(`${prefix}_TIMEOUT_MS`, 20000, 1000, 60000),
    };
  };
  const reasoning = model("reasoning"),
    conversation = model("conversation");
  if (!reasoning || !conversation)
    throw new LocalError(
      "Reasoning and conversation roles cannot be disabled.",
    );
  const roles = {
    reasoning,
    conversation,
    extraction: model("extraction"),
    stt: speech("stt"),
    tts: speech("tts"),
  };
  const revision = createHash("sha256")
    .update(JSON.stringify(roles))
    .digest("hex");
  return freeze({ ...roles, revision });
}

export function roleDiagnostics(roles: ProviderRoles) {
  const model = (profile: ProviderRoles["reasoning"], binding: string) => ({
    ...profile,
    binding,
    status: "configured_not_probed",
    inferenceVerified: false,
  });
  const speech = (profile: ProviderRoles["stt"]) => ({
    ...profile,
    status:
      profile.provider === "disabled"
        ? "disabled"
        : profile.provider.startsWith("fixture-")
          ? "fixture_only"
          : "adapter_missing",
    liveEnabled: false,
    languageQualityVerified: false,
  });
  return {
    revision: roles.revision,
    reasoning: model(roles.reasoning, "internal_adapter"),
    conversation: model(
      roles.conversation,
      "chat_default_with_per_turn_selection",
    ),
    extraction: roles.extraction
      ? model(roles.extraction, "internal_adapter")
      : null,
    stt: speech(roles.stt),
    tts: speech(roles.tts),
    liveSpeechEnabled: false,
    publicAudioEnabled: false,
    generalTaskRolePinning: false,
  };
}
