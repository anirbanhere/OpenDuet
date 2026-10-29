# Saved structured task proposals

The self-hosted console can request one structured proposal from the configured reasoning model. Conversation model selection stays independent. A task saves its original role bundle without credentials, goal, locale and optional exact date; later operator changes do not replace those settings on a duplicate request. Current provider enable/allowlist/cost guards still apply when calling a pinned role. No secret or provider consent is inferred from the snapshot.

This is a draft workflow, not a general autonomous executor. The only represented capabilities are a controlled demo-clinic availability lookup and manual guidance. No steps run here. For an actual SQL simulation, the separate demo appointment panel still requires its own exact review and approval. A draft never becomes a receipt, grant, genuine appointment, payment or notification.

## Try it

Run the normal self-hosted server using the existing ignored profile (`bun run saathi:start`), then open **Plan an everyday task**. New schema v6 is required; use a fresh synthetic database for development instead of pointing at a private/v5 process. This guide does not authorize overwriting an existing profile or migrating public state.

1. Enter a synthetic goal and language. For a demo-clinic lookup, confirm an exact India date separately.
2. Check the displayed reasoning model. Sending the goal starts one inference attempt, shared with the chat allowance. Goal/date/locale go to that provider; this path sends neither chat history nor reviewed preferences.
3. Review the saved proposal, question or unavailable state. Model-generated prose is unverified, even after schema validation.
4. Use **Refresh saved plans** while a response is slow; cancel a saved draft if needed. Reload reads state without inference. A new clarified goal is a new task/request and consumes another attempt.

Free provider capacity and strict JSON support are not guaranteed. Malformed JSON or unsupported plans fail and are not silently repaired/retried. No live-provider quality claim follows from injected tests. Missing or blocked keys leave a saved failed task; no external action ran. Speech remains disabled.

## Contracts and policy

The reasoning request has no native search/tool calls. It asks for strict JSON with the unchanged goal, status, up to three steps, dependencies, tool names, READ/DRAFT risk, approval flag, expected output, one-second step timeout and `none` compensation. A server-owned discriminated schema accepts only `demo.clinic.options` with an exact date and `handoff.manual` with bounded text. Duplicate/forward dependencies, extra fields, write capabilities, forged risk and a lookup date differing from the separate confirmed field are rejected. Prompt guidance is not the enforcement boundary.

Clarification/unavailable proposals have no steps. No claim in manual text authorizes an action. There is no remote MCP discovery, generic grant engine, live provider or payment credential intake. The general observe–plan–act loop, durable step observations and normalized provider outcomes are later work; arbitrary web URLs/scripts cannot become tools through this schema.

## API and persistence

| Method/path | Behavior |
| --- | --- |
| `POST /api/task-plans` | Strict `{request_id, goal, locale, date?}`; save/pin, reserve one attempt, call planner once, validate and save proposal |
| `GET /api/task-plans` | Up to 30 owned saved tasks |
| `GET /api/task-plans/:id` | Owned proposal, settings and compact activity |
| `POST /api/task-plans/:id/cancel` | Strict empty object; cancel without executing a step |

All use the existing same-origin/session boundary; writes require CSRF. Clients cannot provide role bundles, purpose, tool grants, model overrides or credentials. Another visitor receives404 for an individual task. Changed reuse of a request ID conflicts; identical reuse returns the original state and role snapshot, including failed/interrupted/cancelled states. Unknown client responses can be reconciled with the same request ID or saved list. No automatic poll or background inference worker exists.

Schema v6 adds `task_plans` and `plan_events`, preserving v5 chat, evidence, memory, bookings and inference usage. In-flight work becomes `INTERRUPTED` on process reopen under the existing single-process database lock. It never replays automatically. Public update requires the retained-disk backup/release procedure; old v5 binaries cannot open v6, and the schema version must never be falsified or downgraded to force startup.

Planning uses the existing global/owner daily attempt ledger before IO in the same transaction as task creation. Failed/interrupted attempts remain charged; duplicates/cancel/status do not add attempts. Chat and planning share the pending-inference guard. Cancelled in-flight work holds its slot until its result/error settles (or restart); late output is discarded. Cancellation does not promise to stop remote computation or reverse billing. No automatic fallback or summarizer inference is added.

## Verification and next work

Focused Bun tests cover ownership/CSRF/strict inputs, v5 migration, saved role routing/key isolation, invalid tool/date/dependencies, shared limits, failed/duplicate/cancel recovery and restart. Browser acceptance uses synthetic fixture responses, including ready, clarification, unavailable and slow cancellation states; these are not model fluency evidence. The audited packed service checks assets, no-key failed-plan persistence/duplicate recovery and existing repeat-safe mock booking. Exact source/CI/public status is in HANDOFF.

Next: permitted read-only step execution with saved observations and explicit per-step recovery; genuine consent/media/STT/TTS integration; broader tool/identity/grant/provider work. Keep real effects behind their separate review, access and reconciliation gates.
