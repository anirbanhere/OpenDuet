# PRD continuation: durable demo appointments

29 October 2026. The human requested a PRD gap audit and implementation. `PRD.md` copies the supplied replacement PRD; the later OpenDuet/self-hosted decisions govern the active stack. Keep Python reference/legacy deployment separate. This branch stacks on `codex/live-web-lookup`.

## Scope and contracts

Implement J1's text appointment path using the already selected controlled demo clinic. No real clinic, payment, message, speech or account integration. All slots, quotes and receipts are explicitly MOCK. Use the existing anonymous owner/session and CSRF boundary; collect no patient name/contact/health history. User chooses an exact India date, slot and language. No model may approve or call this workflow on its own.

SQLite schema v5 adds owned demo tasks, one current hashed approval per task, idempotent decision receipts, uniquely reserved mock slots and a compact task audit. Keep existing v4 messages, sources, memories and usage ledger. Atomic synchronous transactions must not contain provider/network IO. Task status: AWAITING_SELECTION -> APPROVAL_PENDING -> COMPLETED, or REJECTED/CANCELLED/EXPIRED/UNAVAILABLE. A completed mock booking is terminal and never claims cancellation of a real appointment.

GET `/api/demo-appointments/options?date=YYYY-MM-DD`: server time/range and available simulated slots. POST `/api/demo-appointments` with request_id, date, locale creates a typed server plan. GET list/detail returns owned status, preview, receipt and redacted transition audit. POST `/:id/preview` with slot_id/version makes a canonical exact quote, ten-minute expiry and new one-time nonce. Reload never returns the raw nonce: review again rotates version and invalidates old approval. POST `/:id/decision` with request_id/version/nonce and approve|reject stores the exact decision digest and result. Identical duplicate returns that result even after response loss; altered replay fails. POST `/:id/cancel` is pre-commit only. Available slots are rechecked in the final immediate transaction, with a SQL uniqueness constraint guarding contention.

Abuse cases: another owner's ID, forged owner/amount/provider fields, wrong/expired/stale nonce, stale version, cross-origin/CSRF, changed decision under reused request ID, duplicate/response loss, two owners choosing one slot, restart and schema upgrade. Bound dates, tasks and audit rows. No inference call or quota reset is needed for the mock workflow.

## Ordered increments

1. Record FR-001..034 gap audit; define/test the durable mock task/approval contract, migrate and prove reopen/ownership/contention.
2. Add existing-session HTTP endpoints and API regressions; retain chat/security/provider tests.
3. Add accessible appointment controls/status/approval/receipt to the existing web UI and verify the actual browser, reload and mobile width.
4. Update setup, requirement status and handoff; secret-scan, publish an unmerged PR, run scoped Linux CI/audit/packed smoke. Public update uses the existing VM and a consistent retained-disk snapshot before migration; preserve all prior state and legacy Cloud Run.

Voice, independent planner/reply routing, real providers, reminders and family identity remain separate requirements in the gap report, not claims made by this mock implementation. No WhatsApp policy conclusion is re-verified by this work.
