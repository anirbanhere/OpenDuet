# Self-hosted Saathi starter

Implemented 28 October 2026 after the human selected fully self-hosted threads and memory. The default root `start` and `saathi:start` now run a local Bun service backed by SQLite. It needs no CopilotKit Intelligence project, licence, thread service, Docker or PostgreSQL server. Upstream's cloud bootstrap remains available only through explicitly named upstream/cloud commands.

This is a bounded **text/storage starter in the OpenDuet fork**, not a migration of its complete React UI, AG-UI runner, worker/computer platform or the older Python Saathi runtime. It reuses the official Saathi tenant definitions. No cloud licence or entitlement is emulated. The separate full OpenDuet entry still has its original requirements and approvals; they were not bypassed to make this mode run.

## What runs

| Capability | Current behavior |
| --- | --- |
| Conversations | Server-owned threads, saved user/assistant text and run status; history survives restart |
| Reviewed memories | Explicitly saved preferences, owner-scoped list/delete and bounded inclusion in model context; no automatic extraction |
| Browser identity | Anonymous local workspace; hashed token, HttpOnly/SameSite cookie, 24-hour session; no household accounts/recovery |
| Model | Typed answer boundary; initial direct OpenRouter compatible adapter and free model only |
| Errors/retries | One outbound attempt; bounded response, sanitized provider error; no paid fallback or automatic replay |
| Roles | Saathi everyday help, kitchen and stock prompts; text answers or drafts only |
| Other features | Actions, speech, bookings, authenticated connectors and background jobs are unavailable |

Self-hosted storage is not offline inference. Sending a chat passes a bounded selection of the owned conversation and reviewed preferences to OpenRouter. The provider's own processing/logging terms still apply. Browser/private filesystem permissions are not encryption at rest or verified consumer identity. Use synthetic data until production identity, retention, backup and host controls are designed.

## Run locally

Use Bun 1.4.3 on PATH; it is the version tested/pinned upstream. Native Windows is supported by this starter, unlike the separate upstream Bash/container bootstrap. From a checkout containing the complete self-hosted review stack:

```sh
bun install --cwd openbot --frozen-lockfile
cp saathi-self-hosted.env.example openbot/.env.self-hosted
bun run saathi:check
bun run saathi:start
```

PowerShell uses `Copy-Item saathi-self-hosted.env.example openbot/.env.self-hosted`. Do not overwrite an existing private profile. Stop the foreground service with Ctrl+C. Root `bun run start` is an alias for the same self-hosted entry. There is no implicit background daemon or Docker stop operation.

Open `http://127.0.0.1:8790`. The browser creates a private local workspace, lets you start conversations and explicitly save reviewed preferences, and restores the workspace after reload/server restart. Chat needs `OPENROUTER_API_KEY` in the private profile; the storage UI starts without it. No new model-provider account is required if an existing operator key is available. A key may permit fewer models than the public catalogue.

Relevant settings:

| Variable | Default / restriction |
| --- | --- |
| `SAATHI_DATABASE_PATH` | This checkout's ignored `.saathi/state.sqlite`; an absolute local path can override it |
| `SAATHI_HOST` | `127.0.0.1`; public bind is refused |
| `SAATHI_PORT` | `8790`, integer 1024–65535 |
| `BOT_MODEL` | `openrouter/free` or an explicit `:free` ID; account permissions/capacity still matter |
| `OPENROUTER_API_KEY` | Optional until chat; `OPENAI_API_KEY` alias accepted |
| `OPENAI_BASE_URL` | Only `https://openrouter.ai/api/v1` in this initial profile |

Cloud thread/memory credentials (`INTELLIGENCE_API_KEY` or `CPK_INTELLIGENCE_API_KEY`) are refused in this profile. No cloud credential is used as a dummy boot token. The old `saathi.env.example` and `upstream:tenant-check` describe the separate upstream profile, not this starter. `saathi:cloud-start`/`upstream:start` are explicit alternatives; do not use them when evaluating the self-hosted path.

## Architecture and permission boundary

```text
Local browser -> Hono owned JSON API -> SQLite threads/messages/runs/memories
                   |
                   +-> tenant prompt + owned recent context -> bounded OpenRouter call
```

`self-hosted/store.ts` owns durable state; `app.ts` validates sessions and binds every operation to the server-resolved owner. No request-supplied owner ID is accepted. `answer.ts` is an injected transport boundary with no action tools. `web.ts` attaches the local console; `index.ts` is the opt-in server entry. It does not import the upstream Intelligence runtime/bootstrap.

Threat boundaries: clients can forge bodies/IDs/headers, memories and model responses are untrusted content, and the external provider can fail, redirect or exceed its response budget. Writes require matching Origin/content type/CSRF; SQL is parameterized; foreign IDs return 404; output is rendered with text nodes; provider redirects are refused. The model never receives session tokens, CSRF, private file paths or API keys as prompt content. No tool registry capable of external effects is registered in this starter, so generated action claims are not verified receipts.

## Durable behavior and limits

SQLite uses foreign keys, WAL and FULL synchronization. A separate SQLite exclusive lock enforces one service process per local database and releases on process death. Main writes are short immediate transactions. This is a local single-host design, not an NFS/distributed lock or a multi-instance Cloud Run store.

The server commits a new user message/run before inference. Request IDs are unique per owner and carry a digest of the thread/text. A duplicate returns its saved result/status; conflicting content returns 409. A second new request while one is running also returns 409. Completion saves the reply and completed receipt atomically. Provider errors mark the run failed, keep the submitted text and expose only a sanitized error. A process restart marks unfinished runs interrupted; it never automatically reissues inference or claims a completed result. The UI's “Check previous send” keeps an ambiguous request ID instead of issuing a new model call.

| Budget | Value |
| --- | --- |
| Browser workspaces | Fifty per local database |
| Threads / messages | Thirty per workspace; 100 messages per thread |
| Memories | Twenty per workspace;2000 characters each; explicit review required |
| Received request | 60,000 bytes, including chunked bodies |
| Chat input / saved answer | 2000 / 16,000 characters |
| Context | Up to 24,000 recent message characters and 8000 reviewed-memory characters; not every historical item is sent |
| Provider | One request, 60s timeout, 64,000 response bytes, 1024 requested output tokens; incomplete/tool-call responses refused |
| Mutation budget | 100 requests/minute per process |

Deleting a conversation deletes its live messages/run receipts. Deleting a memory deletes its live preference record; prior messages/model replies may still mention it. Neither operation proves backup, SQLite WAL/free-page, previously downloaded copy or provider-log erasure. Session expiry denies access but does not physically erase data. Retention/export/recovery and encrypted production storage remain separate work. Do not use these run receipts as a payment/booking ledger.

## Verification

- 25 new tests pass across actual SQLite/reopen, ownership, duplicate/conflicting/concurrent sends, failed-run recovery, explicit memory review/delete, actual child-process kill/lock release, strict body/schema/free/local settings and bounded one-attempt provider behavior. Ten existing tenant tests and 20 nearby provider/URL tests also pass: 55 explicitly selected tests total. The dedicated `bun test self-hosted` filter additionally includes ten existing upstream learning-setup tests, so that job's count is 35.
- Server TypeScript, changed-file Biome and console JavaScript syntax pass. No dependency/lockfile changed. CI uses injected/synthetic transports and no production keys.
- Actual isolated browser fixture at 8791 saved a reviewed synthetic preference, sent a message, received a labelled synthetic answer, and restored both after process death/restart plus reload. Memory and thread deletion removed their live records; deleting the thread hid its button and restored focus to New conversation. Mobile 390px client/scroll 390/390; desktop 1440px client/scroll 1425/1425. The resumed page had no console warnings/errors. This is storage/UI evidence, not live model or language-quality evidence.
- The existing operator key permits one free Gemma model. Initial synthetic SDK smoke returned 429 and revealed three automatic attempts/raw provider diagnostics; the new direct adapter replaced that path. A corrected live check made one attempt and returned a clean 503 stating the free provider was busy, with no additional application diagnostic output. No successful live inference or household-data test is claimed.
- The broader inherited CI at the earlier fork head had a first-day-date test failure (10123 pass / 75 skip / one fail) and Python LangGraph-AGUI provider-boundary failures in untouched paths. Scoped success is not a claim that the whole upstream platform is green. See HANDOFF/current PR checks for exact sources and later results.

Use `bun run saathi:self-hosted:test` for the 25 new tests. Source/runtime behavior follows the installed Bun 1.4.3 API; the [official SQLite reference](https://bun.sh/docs/runtime/sqlite) explains its parameterized statements, transactions and WAL/close behavior. Local success does not prove a public deployment is ready.

## Next slices

1. Choose a permitted free model with available capacity; keep provider guardrails and no paid fallback.
2. Connect the full upstream React UI through an explicit self-hosted thread backend contract. Background runs/locks/reconnect and approvals must be adapted and tested, not pointed at a dummy Intelligence service.
3. Add stronger identity, recovery, deletion/retention/backups and a PostgreSQL backend before shared/public or multi-instance hosting. Cloud Run ephemeral SQLite is not durable hosting.
4. Bring the controlled mock dental tool through exact preview/approval/idempotency/reconciliation, then evaluate independent Indic STT/TTS. These are not capabilities of the current text starter.

No VM, Cloud SQL, GKE, public endpoint, WhatsApp account/message, payment or genuine booking was created by this work.
