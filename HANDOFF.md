# Saathi on OpenDuet handoff

## Active continuation — fully self-hosted storage

28 October 2026. Human chose fully self-hosted threads/memory; that preference is resolved. Current branch `codex/self-hosted-demo` adds the runnable console/default startup on the owned API/store stack. Read `docs/saathi/self-hosted.md` for commands, contracts, budgets and limits; `self-hosted-plan.md` records the initial bounded design.

The default `bun run start` / `bun run saathi:start` entry is a local Bun/Hono/SQLite chat and explicitly reviewed-memory console. No Intelligence credential, fake entitlement, remote memory fallback, Docker or PostgreSQL service is required. It reuses the Saathi tenant definitions. Full upstream React UI, workers, computer actions, speech, accounts and external actions have **not** been ported. Existing Python code, open PRs and public GCP deployment were not changed.

### Review stack

Do not merge automatically. Integrate/retarget serially:

1. [PR1 tenant kickoff](https://github.com/anirbanhere/OpenDuet/pull/1), `codex/saathi-kickoff`, base main, checkpoint `fde7845`.
2. [PR2 durable storage](https://github.com/anirbanhere/OpenDuet/pull/2), `codex/self-hosted-storage`, base kickoff, commit `bd7b7c2`.
3. [PR3 owned API/model adapter](https://github.com/anirbanhere/OpenDuet/pull/3), `codex/self-hosted-api`, base storage, commit `140f1ec`.
4. [PR4 local starter](https://github.com/anirbanhere/OpenDuet/pull/4), `codex/self-hosted-demo`, base API, runtime commit `fcd3136`: local console/startup plus visible failed/interrupted run state, static-response headers and reserved reply space at the message cap. Follow-up narrows the injected HTTP transport contract/removes unsafe test casts and includes the frozen test-type gate in focused CI. Inspect current-head checks before integration.

### Verification and present limits

- Local: 25 new tests across five suites passed; ten existing tenant tests and 20 nearby model-provider/URL tests passed (55 selected total). Server TypeScript, changed TypeScript Biome and console JavaScript syntax passed. No dependency or lockfile changes.
- Tests exercise real SQLite reopen, owner boundaries, received-byte/schema limits, duplicate/conflicting/concurrent sends, preserved failed runs, explicit memory review/delete, actual child-process death/lock release, interrupted-run recovery without replay, and bounded one-attempt model responses. Static assets now have the same no-store/CSP headers as JSON responses; a regression caught their initial omission.
- Actual isolated browser fixture: reviewed synthetic preference, chat reply, process-kill/restart restoration, memory/thread deletion and focus recovery verified. Mobile 390px client/scroll 390/390; desktop 1440px client/scroll 1425/1425. Resumed page had no console warnings/errors. Fixture answers are explicitly labelled and prove no live inference or language quality.
- Scoped [storage CI 40712630721](https://github.com/anirbanhere/OpenDuet/actions/runs/40712630721) passed at `bd7b7c2`; [API CI 40712639613](https://github.com/anirbanhere/OpenDuet/actions/runs/40712639613) passed at `140f1ec`. The final local `bun test self-hosted` run passed 35 tests (including ten upstream learning-setup tests); TypeScript completed with exit 0. CI contains no production credentials or live inference. Inspect the demo branch's current checks separately.
- Console source `c54aa92` passed [self-hosted CI 40716507935](https://github.com/anirbanhere/OpenDuet/actions/runs/40716507935), [tenant/build CI 40716507867](https://github.com/anirbanhere/OpenDuet/actions/runs/40716507867) and [security scan 40716507973](https://github.com/anirbanhere/OpenDuet/actions/runs/40716507973). Its broader test-type gate correctly caught two new mock `fetch` casts: the injected boundary now specifies only the callable request contract it actually needs. Six provider tests and server types passed after the fix. Local Windows frozen test-type checking now reports only the eight already-recorded gallery TS6142 errors with absolute paths versus the baseline's relative text; no self-hosted diagnostic remains. Baseline unchanged; this is not a claim that that local gate passed. The focused Linux CI now runs this gate too; inspect the follow-up head's result.
- Corrected code source `906e5cb` passed [self-hosted CI 40717254237](https://github.com/anirbanhere/OpenDuet/actions/runs/40717254237), including the frozen test-type gate, [tenant/build CI 40717254224](https://github.com/anirbanhere/OpenDuet/actions/runs/40717254224) and [security scan 40717254040](https://github.com/anirbanhere/OpenDuet/actions/runs/40717254040). The final handoff-only commit records this evidence; it does not change executable source. Broad platform CI is a separate result, not implied green by these checks. PR4 remains draft/unmerged. The working checkout is clean after publication.
- Earlier inherited [platform CI 40640948584](https://github.com/anirbanhere/OpenDuet/actions/runs/40640948584) had 10123 pass / 75 skip / one first-day-date test failure, plus Python LangGraph-AGUI provider-boundary failures (`x-api-key`). Those paths were untouched. Do not call the whole upstream suite green or assert independently reproduced baseline failures.

The existing operator OpenRouter key was selectively mapped into ignored `openbot/.env.self-hosted`, never printed. Its catalogue permits only `google/gemma-4-26b-a4b-it:free`. An initial synthetic SDK smoke returned 429 and exposed automatic retries/raw diagnostics; the final direct adapter replaces it with one bounded fetch, no SDK runner, raw logging or paid fallback. The corrected live check returned sanitized HTTP 503 / provider 429 with no additional application diagnostics. No successful live answer or household-data test is claimed. Do not dump old SDK process logs: they include synthetic prompts/provider account metadata.

The local profile points to ignored `.saathi/synthetic-browser-review.sqlite`. The final service was restarted at `http://127.0.0.1:8790`; health/static headers and the real entry's browser welcome screen were checked without another inference call. `bun run saathi:start` starts it from this fork; Ctrl+C stops it. The synthetic fixture at port 8791 was stopped; its separate `.saathi/fixture-ui-review.sqlite` is only test data. Neither private file/database is committed. The configured-secret scan of the review stack found zero matches. Local sessions expire after 24 hours with no account recovery; reviewed memory is bounded context, not guaranteed inclusion of every item. Deletion removes live records, not backups/provider logs. No public deployment is appropriate yet.

Next actionable work: obtain capacity on a permitted free model without weakening key guardrails, then adapt the full upstream UI/runner to an explicit owned backend contract. Stronger identity, retention/recovery and a PostgreSQL backend precede shared/public multi-instance hosting. Bring controlled mock dental tools and independent Indic speech through separate tested slices. No Intelligence account/key is needed for the starter.

## Prior fork checkpoint

28 October2026, Asia/Kolkata. Human requested forking the repo linked in Atai Barkai's OpenDuet announcement and starting customization. Fork: https://github.com/anirbanhere/OpenDuet; origin is this fork, upstream is https://github.com/CopilotKit/OpenDuet. Base `60fd4c71d9d82e13739dce00827278154d13c947`, branch `codex/saathi-kickoff`. Preserve MIT notices. The Python Saathi/Home Agents repo, its open PRs and public GCP service were not migrated, merged or deployed.

## Implemented

- New official-extension tenant `openbot/examples/saathi/`: Saathi brand, main everyday-task assistant plus kitchen/stock specializations, three in-app workstreams, five instruction skills, no seeded connector tool refs/private knowledge roots.
- Response-language instructions for Hindi/Tamil/Malayalam/Kannada/English; first speech evaluation remains en/hi/ta. No claimed measured fluency, speech quality or UI translation.
- OpenRouter compatible endpoint/free-model startup example; one `BOT_MODEL` feeds the tenant and sample bot. `saathi:check` refuses missing provider/Intelligence configuration, wrong endpoint/protocol, non-free model and non-loopback profile; it prints names/readiness only. `saathi:start` runs this check before the upstream Bash startup.
- Root README, AGENTS/CLAUDE/SOUL/MEMORY, architecture/setup/roadmap guide and parallel developer handoff template. No actual four-person assignment exists.
- Focused no-secret CI workflow. No platform auth/gateway/approval code, lockfile, upstream model picker or production setting changed.

## Verification

- Pinned Bun1.4.3 and upstream frozen lockfile installed in an isolated local checkout; lifecycle scripts skipped for the dependency rehearsal. The Bun runtime/tooling is outside this repository.
- New test was red before the tenant/preflight implementation. Initial9 focused tests plus20 nearby upstream provider/URL tests passed. Review then reproduced acceptance of the public vault-key placeholder; a regression failed before adding the nonzero32-byte key check. Final counts are10 focused plus20 nearby tests. HTTP-provider tests use injected transports, not live accounts.
- Real Saathi application-config generation produced tenantId `saathi`, productName `Saathi`. Real Vite production build passed (17158 modules,24.54s); upstream warns about large bundles. No key/service is required for this build.
- `bun --env-file=saathi.env.example scripts/saathi-preflight.ts` validates the tenant and flags blank model/Intelligence keys plus the public encryption placeholder as NEEDS SETUP. This is an intentional incomplete-config result, not a live test. No actual `.env`/account key file was created.
- Docker Linux daemon is unavailable locally (`dockerDesktopLinuxEngine` pipe missing). Full startup, SQL migrations, real model/tool/approval execution, account connections, browser end-to-end flows and live speech have not been run.
- [Fork PR1](https://github.com/anirbanhere/OpenDuet/pull/1). Initial [Saathi CI40640536886](https://github.com/anirbanhere/OpenDuet/actions/runs/40640536886) passed tenant/provider tests and the actual frontend build at source `7533264`. Inherited [platform CI40640536945](https://github.com/anirbanhere/OpenDuet/actions/runs/40640536945) is separate; inspect current-head results before merge. Linux format/lint/types passed there; the local Windows type-baseline gate instead matched eight existing gallery diagnostics with absolute Windows paths against relative baseline text and failed. Baseline/source were not altered to hide it. Focused tests are not full-upstream-suite proof.

## Important limits

CopilotKit Intelligence is currently required upstream for threads/memory: a separate credential and remote data store. Optional telemetry is disabled in the example, but that does not make conversations local. Startup checks are not runtime spend enforcement; upstream UI can change models, so provider key guardrails remain necessary. No automatic paid fallback is configured.

Prompts cannot grant/enforce security. The upstream platform advertises approvals, credential isolation, computers and scheduling; verify each for the Saathi flow before using real accounts. Existing first-day/onboarding/brief UI remains work/Gmail-oriented. In-app workstreams do not implement WhatsApp groups, family roles or privacy isolation. Real booking, payment, grocery, media extraction, persistent inventory and WhatsApp are not connected by these YAML files. Do not claim their completion.

## Historical next step (superseded)

The earlier cloud-storage preference question is resolved by the self-hosted choice above. Upstream Docker/cloud bootstrap remains a separate optional mode; it was not run or silently enabled. Follow the active continuation instead.
