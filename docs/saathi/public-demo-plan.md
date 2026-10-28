# Shareable demo plan

29 October 2026. Human requested deployment for sharing and confirmed questions about backend/database. Target: existing GCP project `sathi-home-agent`, `us-central1`; preserve the older Cloud Run website. This authorizes this bounded deployment, not merges or unrelated cloud resources.

Use one small Compute Engine VM with persistent standard disk, Bun service behind Caddy HTTPS, and a fresh demo SQLite database. This preserves self-hosted thread/memory storage without introducing an external conversation SaaS or putting SQLite on an unsupported object-store filesystem. It is a single-server demo, not high availability or verified household identity.

Public backend remains bound to loopback behind the TLS proxy. An explicit HTTPS public-origin setting validates the Host and write Origin; cookies become Secure and HTTPS responses include HSTS. The existing anonymous, isolated, expiring browser workspace model remains; no private local database, account connection or recording is uploaded. Keep text/draft-only capability disclosure.

Add durable SQLite inference-attempt budgets: 20 global and five per workspace per UTC day by default. Reserve atomically before inference, count failures/interruption, do not count duplicates, do not reset quota by deleting a thread/restarting the process. Keep OpenRouter free-only and no automatic model/provider retry. Meta billing/credit eligibility remains unverified. Attempt limits are not an exact dollar ledger.

Only a vetted bundle, public tenant files and web assets enter the deployment package. Build with environment inlining disabled, inspect source upload allowlist and scan known secret values. Model keys come through resource-scoped Secret Manager access; no keys in image, startup metadata or build source. VM identity must not get project-wide data access.

Acceptance: config/Host/Origin/Secure-cookie/quota/migration tests; bundle starts with explicit tenant/web paths and synthetic DB; scoped CI and audit review; HTTPS health/browser flow; two visitor isolation; one synthetic authorized live inference, duplicate check and restart persistence. Record URL/resource names, exact source/build/CI evidence, costs/limits and rollback/stop procedure. No automatic deployment from PR CI.
