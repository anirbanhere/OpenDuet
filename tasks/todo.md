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
- [ ] Triage inherited audit findings: 122 vulnerabilities, including three critical
- [ ] Production authentication, retention, queue budgets, and operator reconciliation

The upstream test type baseline reports eight inherited JSX path mismatches on
Windows. No baseline entries were changed. The wider tenant database suite timed
out on the PGlite fixture and is not claimed as passing. See
`docs/Saathi-Implementation.md` for supported behavior and deployment constraints.
