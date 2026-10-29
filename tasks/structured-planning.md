# Structured planning: first durable read-only slice

29 October 2026. Branch codex/structured-planning, stacked on PR11. The active PRD goal authorizes continued implementation; this bounded slice advances FR012–018 without adding real account actions.

## Contract and limits

Create an owner-scoped task from request_id, goal (1–2000 characters), locale (en/hi/ta), and an optional user-supplied exact YYYY-MM-DD date. Pin the credential-free immutable role bundle and request digest at creation. A changed operator configuration or browser chat selection must not change an existing task. One bounded reasoning call produces strict JSON, with no tool execution during planning and no automatic inference fallback/retry. The optional conversation/extraction roles are saved but no additional summarizer call is made.

Accept only typed plans with goal, up to three ordered steps, prerequisites, allowlisted tool names, risk/approval requirements, expected output, timeouts and compensation. The initial registry exposes a read-only controlled demo-clinic slot lookup and an unverified manual draft/handoff. Missing real capabilities produce unavailable/clarification; arbitrary tool names, writes, credentials, URLs/commands and fabricated material date fields cannot become executable operations. A date argument must exactly match the separate user-confirmed date; goal text is not a date authorization.

Save explicit planning/draft/clarification/unavailable/failed/interrupted/cancelled states. This slice does not run plan steps or create/approve appointments. Reuse the current exact mock-appointment panel for booking review. Saved plans are proposals, never receipts or evidence that a task was completed. Step execution/observe loop follows separately.

## Storage, API and budget

Add schema v6 planning tables without deleting v5 data. Preserve chat/source/preferences/mock bookings/usage. Old v5 binaries cannot open v6; public deployment requires a consistent backup and explicit release, not merely running local tests. No production database or private local process is touched during implementation.

Separate module owns planning SQL, types and routes. Same session/origin/CSRF/body-size boundary as existing HTTP. GET/POST /api/task-plans, GET /api/task-plans/:id, POST /api/task-plans/:id/cancel. Clients cannot provide role snapshots, model purpose, tools, grants or provider keys. Duplicate request IDs return original saved state; changed content conflicts. Ownership failures return404.

Reserve one planner attempt in the existing durable inference_usage ledger transactionally before IO; share the global/owner daily allowance and one-running-inference-per-owner guard with chat. Failed/interrupted calls consume their reserved attempt; duplicates/cancel/reload do not. On process reopen, in-flight planning becomes interrupted and is never replayed automatically. Cancelling suppresses any late plan save; cancellation does not promise remote billing reversal. No background worker or notifications.

## Ordered increments and checks

1. Failing storage/contract tests, then additive task schema, pins, duplicate/reopen/cancel/ownership/shared-budget behavior. Commit the working storage increment.
2. Failing planner/API tests, then strict plan validator, bounded reasoning adapter and routes. Verify malformed/unsafe outputs, provider role isolation, no hidden lookup, shared quota, cancellation and duplicate recovery. Commit.
3. Small dedicated UI module for text goal/date/locale and honest saved plan/status/cancel display, after contracts pass. Real-browser mobile/reload/error verification. Review source, audited bundle and packed smoke; draft PR12 and exact-source Linux CI. Deploy only when reviewable/ready with existing snapshot safeguards.

Use Bun1.4.3, current Hono/Zod/SQLite, no dependency or broad upstream refactor. Existing commands: from openbot run bun test self-hosted; bun run --cwd server typecheck; bun run typecheck:tests; bun ../scripts/build-demo.ts --audit; bun ../deploy/public/smoke-bundle.ts. Add the focused test file to the explicit root self-hosted command. Preserve frozen upstream test-type baseline. No real speech/model/API smoke is needed; injected transports and synthetic fresh databases are sufficient.

## Progress

- [x] Durable storage/pins and shared budget.
- [x] Typed planner/provider/API boundaries.
- [x] Review UI and synthetic real-browser acceptance; no live model/fluency claim.
- [ ] Final CI, review PR and deployment decision/handoff.