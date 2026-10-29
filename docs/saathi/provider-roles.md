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

Role profiles are deeply immutable credential-free configuration snapshots with a SHA256 revision. This is not yet durable role pinning for generic multi-step tasks. Existing chat run IDs pin their selected model and do not replay interrupted work. Every additional future planner inference must integrate with the durable usage ledger before exposure to public users; an internal adapter is not a budget bypass.

## Diagnostics and authority

GET `/api/provider-roles` uses the existing session boundary. It returns role choices/budgets, configuration revision and honest status, never keys. Model status is `configured_not_probed`: configuration is not provider availability, language quality, tool/JSON support or successful inference evidence. No public route changes server role settings; unknown fields such as `purpose` on the chat HTTP request are rejected.

Diagnostics explicitly report live speech/public audio disabled and general task role pinning incomplete. Configuring a candidate speech provider/model does not register its adapter or authorize audio upload. The next speech-contract increment provides synthetic-only evaluation; genuine adapters, owner-scoped consent/media retention and actual en/hi/ta quality evaluation follow separately. Malayalam/Kannada remain requested evaluation targets.

Operator configuration belongs in the existing ignored private profile or Secret Manager, never chat/committed YAML. Do not overwrite a configured profile with the example. This slice requires no new provider key, live model smoke, database migration or public upload endpoint.
