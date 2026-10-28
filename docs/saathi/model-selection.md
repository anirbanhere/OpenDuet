# Provider keys and reply model selection

28 October 2026. This is for the local OpenDuet fork starter, not the older public Python website. Models provide text answers/drafts; changing inference does not enable action tools, WhatsApp or speech. Threads and reviewed preferences remain in local SQLite. Context is sent to the selected provider for each answer.

## Add the Meta key

Edit the ignored file `openbot/.env.self-hosted` in this checkout. Preserve the existing OpenRouter settings and key. Add/update:

```dotenv
META_API_KEY=your-meta-model-api-key
SAATHI_ENABLE_META=true
SAATHI_META_MODELS=muse-spark-1.3
```

`MODEL_API_KEY` is accepted as a Meta alias; `META_API_KEY` takes precedence. Never put a key in chat, browser JavaScript, Git, screenshots or committed examples. The checked-in example contains empty key fields only. This key belongs to `dev.meta.ai`; it is not a WhatsApp token or an OpenRouter credential. Do not change `OPENAI_BASE_URL` to Meta: the adapter routes each provider to its own fixed endpoint and key.

Restart the foreground local service with Ctrl+C, then `bun run saathi:start` from the fork root. Open `http://127.0.0.1:8790/`, start/restore the local workspace and use **Reply model**. Refresh the page after a server restart. `bun run saathi:check` prints configuration presence only, never credentials. A key in a running process is not automatically refreshed from disk.

The app discovers Meta models with `GET https://api.meta.ai/v1/models` and intersects them with `SAATHI_META_MODELS`. Supported Standard-mode text IDs are `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`, `muse-wonder-1.0`; the default is only Spark 1.3. Contributor, image and transcription models are excluded from this text picker. A catalogue listing does not prove successful inference, available quota or Indic quality.

## Free or inexpensive OpenRouter

The default is free-only. Eligible options come from OpenRouter's authenticated `/api/v1/models/user` response and must have valid text/token-limit support, known nonnegative token prices and no listed request fee. Current rows omit request pricing; this is accepted because every inference request independently caps request fees at zero. Explicit null, invalid or nonzero request fees are excluded. No public catalogue is used to bypass account model permissions. If the key permits only one model, only that eligible model will appear.

To allow inexpensive paid OpenRouter models, deliberately set:

```dotenv
SAATHI_ALLOW_PAID_MODELS=true
SAATHI_MAX_INPUT_PRICE=0.25
SAATHI_MAX_OUTPUT_PRICE=1.00
```

The example ceilings mean **USD per one million input/output tokens**, not dollars per call. Restart the service. The selector shows eligible models with their listed token rates, sorted by input then output price. The configured `BOT_MODEL` remains the OpenRouter default if eligible; other selections apply to the next send in the same conversation. If the default is unavailable, choose explicitly. No model is silently substituted.

The server enforces selection eligibility and sends OpenRouter `provider.max_price` with both token-rate caps and a zero per-request fee. A `:free` model receives zero token caps even when paid models are enabled. Provider fallbacks are disabled, and there is no fallback model array or automatic inference retry. Missing/over-cap prices are excluded. Catalogue results are cached for up to five minutes; errors for 30 seconds. Refresh model list uses that cache; restart after key/permission/profile changes when an immediate refresh is needed.

These are **token-rate ceilings, not a monthly or per-conversation spending ledger**. Set an appropriate key/account spending limit in OpenRouter too. Your existing key's account guardrails can still block paid models, even when the local opt-in is true. The app does not alter those guardrails.

## Meta costs and privacy

Meta is a separate opt-in. OpenRouter's price caps do not govern Meta. Meta options say billing/credits are unverified; this app does not read your hackathon credit entitlement or promise free calls. Check the project's own budget/credits before selecting Meta.

Public Standard-mode rates checked on 28 October 2026 were USD 1.25 input / 4.25 output per million tokens for Spark, and USD 4 / 20 for Wonder. These are reference rates, not your actual invoice or hackathon entitlement; verify the [current Meta pricing page](https://dev.meta.ai/docs/pricing-rate-limits). Contributor mode is cheaper in exchange for allowing content to train models; it is intentionally excluded rather than silently enabled as a cost optimization.

Meta requests use `POST https://api.meta.ai/v1/chat/completions`, developer instructions, `max_completion_tokens=1024`, minimal reasoning, `store=false` and no tools. There is no Responses thread ID, server-managed conversation chain, file upload or cloud-memory client. Provider processing/logging policies still apply; self-hosted application history is not a promise that no remote processing occurs. No live paid or Meta inference test was made in this implementation slice.

## Run identity, persistence and errors

- A selected provider/model is saved with the run and displayed as the last send's model. Model switching retains the thread and reviewed preference context. On reload, an eligible last-used model is restored for the latest conversation; there is no global account preference system.
- Request identity includes thread, text and selected model. Reusing an ID with a changed model/text returns 409. Reusing the original ID returns its saved receipt without another inference request, including when the provider catalogue is unavailable.
- During an uncertain send the picker and text are locked. **Check previous send** reconciles the original request ID/model; after a terminal state, choose/edit a new send explicitly. A reload restores saved history/status without automatically replaying the request.
- Invalid/forged selections fail before a new message/run or inference call. A provider failure preserves the submitted user text and failed run. No retries or provider switching happen automatically.
- Local schema v2 adds nullable `runs.model`, migrating v1 transactionally. Existing messages/sessions/preferences survive; historical model identity stays unknown. The old v1 starter cannot reopen a v2 database. Stop the service before taking/restoring a consistent SQLite backup, including any WAL sidecars; do not edit the version row to fake a downgrade. This local migration does not touch the Python/GCP database.

`GET /api/models` requires the same owned browser session as the other APIs. `POST /api/threads/:id/messages` accepts optional `model` as the selection ID returned by that catalogue (for example `meta:muse-spark-1.3`), not a custom base URL or API key. Old clients omitting the field use the configured OpenRouter default. Duplicate historical v1 requests can still be read without inventing model metadata. All session/CSRF/origin/ownership, input/context/response limits and no-external-action boundaries remain.

## Verification

The self-hosted filter passed 52 tests locally: 42 starter tests plus ten existing upstream learning-setup tests. New cases cover strict opt-ins, schema migration, model-bound duplicate identity, key-filtered/free/cheap eligibility, unknown/negative prices and fees, provider credential separation, bounded/erroring catalogues, Meta request shape and API selection/reconciliation. A real catalogue read caught the omitted request-price field; a regression was red before correcting its schema/filter. Server types and changed-file Biome pass. Windows test-type baseline checking has only the previously observed eight gallery path-text mismatches; inspect the scoped Linux CI for the authoritative baseline gate. No baseline was changed.

Real browser fixture evidence: two clearly labelled synthetic models answered in the same thread; history and last-model metadata survived reload and fixture restart. An injected failure left model/text locked; checking the original send unlocked them without adding another message (five saved messages remained). Mobile client/scroll width 390/390; desktop 1425/1425. Console was clean before the deliberate HTTP 503 fixture failure. These tests do not prove live Meta inference or language quality.

Sources: [Meta chat API](https://dev.meta.ai/docs/protocols/chat-completions), [Meta schema/token budget](https://dev.meta.ai/docs/api-reference/chat-completions/schemas), [Meta model schema](https://dev.meta.ai/docs/api-reference/models/schemas), [OpenRouter user catalogue](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails), [OpenRouter provider price filter](https://openrouter.ai/docs/guides/routing/provider-selection#max-price).
