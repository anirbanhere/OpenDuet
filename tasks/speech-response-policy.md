# Bounded response composition

Stack on PR17, with no public registry/route or schema change. Implement internal `createSpeechReplies(role, adapter?)`, pinning a copied server-owned TTS identity/languages/deadline. `compose` accepts strict bounded text, locale, explicit response policy, optional boolean processing consent and a cancellation signal.

- `text_only`: return text; never invoke TTS or require speech consent.
- `voice_only`: text is always null, including missing consent, unavailable service or provider failure; no silent text fallback.
- `text_and_voice`: retain text while reporting unavailable voice explicitly.
- For voice, require literal consent and enabled locale/model/adapter; enforce the short500-unit vendor text ceiling without truncating critical fields or making another model call.
- Invoke one injected adapter with a bounded deadline and parent cancellation. Do not retry or switch provider; abort must suppress late results. Normalize failures to fixed codes/messages without raw provider details.
- Reuse structural audio validation and inspect actual PCM WAV. Locale, source identity/mode, duration and speech/fixture evidence must agree. Copy returned audio bytes; fixture tones yield fixture_only with no deliverable voice.
- Returned composition is not message delivery, a receipt, a consent ledger or permission to register public voice. Owner media/durable consent/retention and spend admission remain separate gates.

TDD: missing-module test first, then text-only zero calls; voice consent/missing-role/cap and exact payload; no text fallback; malformed/cross-locale/forged duration/identity/fixture evidence; deadline/parent/immediate abort and private-error redaction. Preserve existing speech/vendor/HTTP/storage regressions. Validate focused suite, server types, frozen Linux baseline and packed app; no paid/live provider calls, new keys or public/private DB change.

Implementation checkpoint30 October2026 (India):123 focused tests/1089 assertions, server types, Biome and audited packed-app smoke pass. Windows frozen types retain only the eight known gallery path-text mismatches; Linux CI and draft PR next. Both real transport implementations are exercised via mocked HTTP only. Internal composition remains unregistered; owner media/durable consent/admission/spend and actual evaluation still follow.
