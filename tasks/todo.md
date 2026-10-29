# Saathi implementation tasks

- [x] Fetch and check out pinned OpenDuet source on a feature branch
- [x] Install locked dependencies; verify migrations on disposable PGlite/pgvector
- [x] Owner-scoped encrypted model settings and runtime integration
- [x] Official WhatsApp client and durable connection workers
- [x] Private Bot, channel, headless execution, and approvals integration
- [x] Companion settings and product package
- [x] Migration, generated schema snapshot, and operator documentation
- [x] 127 focused tests plus six SQL-backed integration tests
- [x] Server/app type checks, app production build, browser verification with simulated services
- [x] Review credential/concurrency boundaries and record live setup requirements

## Review disposition

Four actionable findings were corrected: poll generations now change on each
claim, retryable 503s require explicit nonacceptance code 131016, multipart enqueue
locks the connection, and outbound completion follows the connection-first lock
order. Regression tests cover stale same-worker polling and recovery without
repeating external work. The user declined the additional cross-model review.

## Pilot and production gates still open

- [ ] Native PostgreSQL concurrency suite (the local SQL fixture supports one connection)
- [ ] Working Docker supervisor and private computer acceptance test
- [ ] Real Intelligence, personal LLM, and eligible WhatsApp account round trip
- [ ] Credentialed task, speech, and language acceptance scenarios
- [x] Patch the three inherited critical advisories; current audit has zero critical findings
- [ ] Triage remaining 112 advisories (45 high, 54 moderate, 13 low)
- [ ] Production authentication, retention, queue budgets, and operator reconciliation

The upstream test-type gate now passes on Windows after checkout-path
normalization; its 239 known diagnostic baseline entries were unchanged.
The wider tenant database suite timed
out on the local PGlite fixture. GitHub CI subsequently verified the Saathi SQL
integration tests on native PostgreSQL 17 with pgvector. See
`docs/Saathi-Implementation.md` for supported behavior and deployment constraints.

## CI and security follow-up

- [x] Fix Saathi lint warnings without disabling lint rules
- [x] Replace an expired fixed date in the first-day fixture
- [x] Await self-host banner mutations before tearing down its test browser
- [x] Verify Anthropic SDK auth/version headers without assuming an older SDK's protocol
- [x] Align Better Auth, integrations, and core at 1.7.7; pin patched sanitization/proxy dependencies
- [x] Verify 148 focused tests, workspace types, baseline test types, lint, format, and production build
- [x] Record advisory sources and remaining audit findings in `docs/Saathi-Security.md`
- [ ] Confirm complete GitHub CI on the final patched dependency commit
