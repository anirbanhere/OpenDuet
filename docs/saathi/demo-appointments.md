# Controlled demo appointments

This implements the text/review/approval part of PRD journey J1 in the active self-hosted OpenDuet app. **Saathi DEMO Dental is a simulation.** It never contacts a clinic, charges money, sends a notification or creates a genuine appointment. The chat model cannot approve or execute this flow. No model key is needed.

## Try it

Start the ordinary self-hosted entry with pinned Bun1.4.3. Before opening a pre-v5 database, stop its writer and make a consistent backup including WAL state. Never replace an existing private profile/database with a fixture. The additive v5 migration preserves v4 data; older binaries cannot open v5.

Click **Try a demo appointment** on the website. Select an exact India date and receipt language, then **Find demo slots**. The shared simulated calendar has three 30-minute slots per date, from today through 30 days ahead. Elapsed/reserved slots are excluded. Task details/receipts remain owner-isolated. No patient name, contact or health history is collected.

Review a slot's date, time, clinic, duration, simulated ₹500 INR total and no-charge/no-notification terms. **Approve mock booking** records a unique `MOCK-SAATHI-...` reference. **Reject request** or **Cancel request** ends an uncommitted task. Completed mock receipts are terminal; real post-booking cancellation/refunds are not implemented.

Reload restores tasks/receipts but never a raw approval token: review again to enable approval. Changing/reviewing a slot increments the task version and invalidates the previous token. Reviews expire after ten minutes. A slot taken by another demo user returns UNAVAILABLE and requires a new review. Each workspace has at most 30 tasks and each task has a bounded review budget; there is no automatic task deletion.

English/Hindi/Tamil receipt summaries are fixed application text, not measured speech/model fluency. The console otherwise remains English. Form values drive this workflow; natural-language extraction/planning from chat is still missing.

## HTTP contract

Existing session owner, same-origin JSON and CSRF checks apply to every route. Unknown fields and client-supplied owner/provider/amount/receipt/hash are rejected.

| Method/path under `/api/demo-appointments` | Request | Result |
| --- | --- | --- |
| GET `/options?date=YYYY-MM-DD` | Optional date, default India today | Date bounds, timezone and selectable mock slots |
| POST `/` | `{request_id,date,locale}`; en-IN/hi-IN/ta-IN | Owned task and pinned plan; identical duplicate returns same task |
| GET `/` or `/:id` | Session only | Owned task(s), state/version, preview, receipt, audit; no raw nonce |
| POST `/:id/preview` | `{slot_id,version}` | Exact quote/hash, ten-minute expiry, incremented version, new one-time nonce |
| POST `/:id/decision` | `{request_id,decision,version,nonce}`; approve/reject | Saved decision receipt; identical duplicate returns same result |
| POST `/:id/cancel` | `{version}` | Pre-commit CANCELLED; completed task ->409 |

Unknown/other-owner task ->404. Stale version, expiry or changed replay ->409; wrong approval ->403; invalid fields/date ->422; task/review budget ->429. Availability is rechecked at commit. Health exposes `demo_appointments:true`; `actions:false` continues to mean no live external actions.

## Persistence and authority

`self-hosted/appointments.ts` owns the fixed capability/plan, quote, policy and SQL mock. `store.ts` uses the same locked database connection. Schema v5 adds `demo_tasks`, `demo_bookings`, `demo_decisions`, `demo_audit`; existing messages/models/sources/memories/usage survive. Mock tasks do not consume inference allowance.

Only a hash of the nonce is persisted, tied to owner/task/version/exact quote. The canonical quote hash is checked before commit. Reservation, receipt, consumed approval/version transition, decision snapshot and audit commit atomically. SQL uniqueness on date/slot and task prevents duplicates. No provider/network IO occurs inside the transaction. Decision identity includes task/action/version/nonce digest; changed replay fails.

The browser retains an uncertain request ID/body in memory for explicit reconciliation. Known rejection, changed version or a saved terminal state enables fresh review. It never restores tokens from browser storage or automatically replays a mutation. UI uses text nodes/fixed controls and an explicitly served/packaged ES module. Expiry is enforced on requests, not by a background cleanup job.

This atomic mock does not solve unknown outcomes from remote booking systems. Real providers require identity/grants, a durable operation/outbox/reconciliation protocol, receipt verification and cancellation rules. No flag turns this fixed mock into a live clinic.

Implementation references: [Bun SQLite](https://bun.sh/docs/runtime/sqlite), [SQLite transactions](https://sqlite.org/lang_transaction.html). Documentation alone is not runtime evidence.

## Verification

Run `bun run saathi:self-hosted:test`, server types and scoped Linux CI. Tests cover owner/CSRF/strict quote boundaries, wrong/stale/expired approval, duplicate/conflicting decisions, contention, terminal cancellation, actual reopen and v4 migration. Packed release smoke confirms a mock task without keys, checks its duplicate receipt/persisted reservation and module asset.

Browser checks cover review -> reload without approval -> changed slot/re-review -> approved Tamil receipt, rejection/cancellation, focus restoration and mobile width. Exact local/public verification and hashes belong in HANDOFF.md. Full remaining work is in [the PRD gap audit](prd-gap-audit.md).
