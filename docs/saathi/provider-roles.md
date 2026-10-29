# Independent provider roles

The self-hosted entry separates reasoning, conversation, optional extraction, STT and TTS configuration. These are different roles, not aliases for a single global model. Public chat remains the conversation role with the existing per-turn eligible-model picker. Reasoning/extraction have an internal adapter seam; they are not yet a general planning workflow.

## Model roles

| Variable | Default / bounds |
| --- | --- |
| `SAATHI_REASONING_MODEL` | `openrouter:` plus existing `BOT_MODEL` |
| `SAATHI_CONVERSATION_MODEL` | Same initial default, configured independently |
| `SAATHI_EXTRACTION_MODEL` | `disabled`; otherwise an explicit provider:model reference |
| `SAATHI_<ROLE>_TIMEOUT_MS` | 60000; integer 1000..60000 |
| `SAATHI_<ROLE>_MAX_OUTPUT_TOKENS` | 2048; integer 128..4096 |

ROLE is REASONING, CONVERSATION or EXTRACTION. References have the form `openrouter:openrouter/free` or an explicitly enabled permitted Meta model. Existing paid/OpenRouter token-rate ceilings, Meta enable flag/key/Standard allowlist and provider key separation remain authoritative. Configuring a role cannot enable a disabled provider or authorize a paid fallback. There is exactly one inference attempt and no automatic fallback.

Normal conversation output retains its previous 1024-token cap, further limited by the conversation role cap. Native lookup can use the conversation role cap (default 2048). Internal reasoning/extraction use their respective caps. Config changes affect new requests. User-selected eligible chat models override the conversation default, while reasoning stays independent. A duplicate request without a repeated model field uses its original saved model rather than the current default; changed text/explicit model still conflicts.

Role profiles are deeply immutable credential-free configuration snapshots with a SHA256 revision. Structured draft tasks now persist these snapshots and share the durable chat inference ledger. A new task can explicitly choose an eligible reasoning model without changing other roles/budgets; its revised snapshot and choice are pinned in request identity. Existing chat run IDs also pin their selected model and do not replay interrupted work. Generic multi-step remote execution is still incomplete; future model calls must use the ledger rather than bypass it through an internal adapter.

## Diagnostics and authority

GET `/api/provider-roles` uses the existing session boundary. It returns role choices/budgets, configuration revision and honest status, never keys. Model status is `configured_not_probed`: configuration is not provider availability, language quality, tool/JSON support or successful inference evidence. No public route changes server role settings; unknown fields such as `purpose` on the chat HTTP request are rejected.

Diagnostics explicitly report live speech/public audio disabled and general task role pinning incomplete. Configuring a candidate speech provider/model does not register its adapter or authorize audio upload. The next speech-contract increment provides synthetic-only evaluation; genuine adapters, owner-scoped consent/media retention and actual en/hi/ta quality evaluation follow separately. Malayalam/Kannada remain requested evaluation targets.

Operator configuration belongs in the existing ignored private profile or Secret Manager, never chat/committed YAML. Do not overwrite a configured profile with the example. This slice requires no new provider key, live model smoke, database migration or public upload endpoint.

## Speech contracts and keyless evaluation

STT and TTS each have `SAATHI_<ROLE>_PROVIDER`, `_MODEL`, `_LANGUAGES` and `_TIMEOUT_MS` settings. Both default to disabled. Fixture providers `fixture-a` and `fixture-b` select explicitly synthetic models; they support only en-IN/hi-IN/ta-IN fixture cases. `sarvam` and `elevenlabs` are configuration candidates requiring explicit model IDs, but their adapters are not connected in this slice. `local-whisper` is an STT-only candidate, never TTS. Candidate configuration is not permission to send audio or a language-coverage claim.

Run from this checkout:

```sh
bun run saathi:roles
bun run saathi:roles:fixture
```

The first command reads the existing private profile and prints credential-free configuration diagnostics only; it does not probe a provider. The second ignores inherited/private model settings and evaluates six synthetic adapter cases, using two fixture STT selections and one independent fixture TTS selection across en/hi/ta. Network fetch/preconnect are blocked in that process. No database, external service, real recording or new key is needed. CI also exercises the actual command with synthetic inherited key values to verify that they never appear in output.

Input fixtures are generated quarter-second WAV tones matched to preset strings by checksum. TTS produces another test tone and explicitly returns `isSpeech:false`; it does not speak the requested text. Confidence stays null and every result carries fixture identity/warnings. This checks provider-role contracts and swaps, not speech recognition accuracy, natural voice quality, code-switching or the PRD's consented 25-utterance-per-language benchmark. Malayalam/Kannada still require real model evaluation.

The interfaces normalize transcript text/language/confidence/alternatives and audio MIME/language/duration/source. Fixture processing requires a literal consent acknowledgement, bounded bytes/text and supported language settings; STT accepts only the known synthetic WAV checksums. This is not a general audio decoder or format validator. This call flag is not a durable user-consent record or ownership grant. Public voice still needs the separate authenticated media/consent/retention design.

Every adapter gets an abort signal and deadline; timeout requests cancellation once with no fallback. A future IO adapter must honour that signal; it is not a hard CPU-process kill. Outputs are schema-checked and fixture identity/evidence mode cannot be upgraded to live. Generic provider exceptions are sanitized. Configuring a live candidate still fails with `adapter_missing`/not connected, even if an operator has a key.

Operator scripts are included explicitly in the server TypeScript gate. Tests cover independent swaps in both directions, invalid combinations, missing consent, unknown audio, unsupported languages, false live/confidence claims, deadlines/abort, sanitized failures, immutable profiles and redacted diagnostics. Existing chat/source/appointment/ownership/usage suites and the packed no-key booking smoke remain required. Exact-source CI and deployment status are recorded in HANDOFF; this document is not proof that voice is enabled on the public site.
