# Model selection slice

Human request: add a Meta Model API credential and choose free or inexpensive inference models. This extends the local text starter; no public deployment, account actions, speech or automatic paid smoke calls.

## Contract and scope

- Keys remain in ignored `openbot/.env.self-hosted`. `META_API_KEY` (alias `MODEL_API_KEY`) is separate from OpenRouter. Only fixed official HTTPS endpoints may receive each key; no browser key/endpoint input.
- Authenticated `GET /api/models` returns a bounded, cached server-filtered list with provider, stable selection ID, name and available token prices. OpenRouter uses `/models/user`, not a public catalogue as permission evidence. Meta uses `/models`, intersected with an operator allowlist of supported Standard-mode text models. No Contributor-mode opt-in is inferred from a request for cheaper models.
- OpenRouter is free-only by default. Optional `SAATHI_ALLOW_PAID_MODELS=true` permits catalogue models below operator token-price ceilings (default USD 0.25 input / 1.00 output per million). Every completion also carries provider-side max-price filters, zero per-request fees and no model fallback. These rate caps are not a monthly wallet limit; provider-side spending limits remain necessary.
- Meta needs `SAATHI_ENABLE_META=true` plus its key. Default allowed model is `muse-spark-1.3`. Its billing/credits are explicitly unverified, and OpenRouter price filters do not apply to it. No automatic provider fallback.
- A message may add an optional selection ID. Application code resolves it from the eligible catalogue. Run identity includes that selection; changing models cannot replay an old request. SQLite migration v1 -> v2 adds nullable run model metadata; historical unknowns remain unknown. The UI locks an ambiguous pending send to its original model/request ID, then allows a new choice after reconciliation.
- Local thread/memory ownership and all existing input, response, rate, timeout and external-action boundaries remain.

## Ordered acceptance

1. Failing then passing config/storage tests: opt-ins, invalid caps, migration/reopen, model-binding duplicate conflicts.
2. Catalogue/provider tests: prices and key permissions, fixed endpoints, wrong/unknown fields, bounded response, no credential crossover, Meta request shape, no paid/default/provider fallback.
3. API tests: owned selection, forged selection rejection before inference, persisted model receipt and duplicates; old clients retain the configured default.
4. Browser fixture: switch between two labelled synthetic models in one thread; check receipt/history/reload, invalid/pending choice behavior and mobile layout. No live paid test is necessary.
5. Scoped tests, server/test types in CI, docs, secret scan and stacked draft PR on the starter. Preserve legacy Python/GCP deployment.

## Primary sources checked 28 October 2026

- [Meta stateless chat](https://dev.meta.ai/docs/protocols/chat-completions), [models](https://dev.meta.ai/docs/api-reference/models/schemas), [pricing](https://dev.meta.ai/docs/pricing-rate-limits).
- [OpenRouter user-filtered catalogue](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails), [provider max-price routing](https://openrouter.ai/docs/guides/routing/provider-selection#max-price).
