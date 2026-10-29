# Speech response policies

Internal `createSpeechReplies(role, adapter?)` in `openbot/server/src/self-hosted/speech-replies.ts` composes an existing reply into text and/or validated audio. It copies the server-owned TTS identity, allowed locales and timeout at creation. Later caller mutation cannot change that selection. It is unregistered with the public app and cannot load a key, select another provider, store media or deliver a message by itself.

`compose` accepts a strict object: `policy`, nonempty trimmed `text` (at most2,000 JavaScript string units), `language`, optional boolean `consentToProcess` (defaultfalse) and an `AbortSignal`. Voice attempts have a500-unit ceiling, without truncation, summarization or another model request. Critical dates/names/amounts remain literal text sent to the selected adapter. These limits do not prove the voice accurately speaks those fields.

| Policy | Text field | TTS behavior |
| --- | --- | --- |
| text_only | Original trimmed reply | Zero calls; no speech consent required |
| voice_only | Always null, including failures | One eligible consented attempt, otherwise explicit unavailable/consent state |
| text_and_voice | Original trimmed reply | Same voice checks; text remains available if voice fails |

Results use `text_ready`, `voice_ready`, `requires_consent`, `unavailable` or `fixture_only`, plus a fixed reason code. A missing/disabled role or adapter, unsupported locale, oversized voice text, failure, timeout or invalid output never silently changes policy or provider. `voice_ready` means composition passed its checks, not that a channel sent a voice note. `text_and_voice` with unavailable audio is partial composition, not successful voice delivery. Caller cancellation rejects with408 and suppresses late output. A bounded deadline aborts even when an adapter ignores cancellation; no automatic retry occurs.

Shared audio parsing validates structural fields and actual bounded PCM16 WAV bytes, checks the declared duration against the inspected rounded-up duration and detaches the returned bytes. Composition also checks the requested locale and pinned provider/model/mode. Fixture tones must identify as fixtures with `isSpeech=false`; they return `fixture_only` and no deliverable audio. Provider-mode output must identify as intended speech. Language and speech metadata do not independently verify acoustic content, fluency or voice rights. Invalid output and raw provider exceptions yield fixed sanitized outcomes.

The tests use generated tones and mocked HTTP, including both actual Sarvam/ElevenLabs transport implementations. They do not contact vendors or establish real access/quality. Existing fixture synthesis now shares the stricter WAV/duration parser; fixture tones remain honest synthetic evidence. Public speech/media routes and schema are unchanged.

Before public voice: owner-scoped uploads/playback, durable consent and revocation, retention/deletion, durable request deduplication and speech admission/spend limits, eligible provider access and actual consented en/hi/ta evaluation. Malayalam/Kannada remain requested targets without quality evidence. No WhatsApp delivery, model-approved action or real transaction follows from a composed reply. The earlier single Meta planning-test approval remains consumed.
