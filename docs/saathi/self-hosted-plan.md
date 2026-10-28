# Self-hosted threads and memory

Human decision 28 October 2026: require fully self-hosted threads/memory. No CopilotKit Intelligence project, credential, licence emulation or network-compatible fake is introduced.

## Runnable slice

Add a separate local Saathi entry point in this fork, using Bun's SQLite and the existing tenant package. A direct bounded OpenRouter adapter is used instead of the SDK's retrying/logging agent path. The full upstream PostgreSQL/Intelligence worker bootstrap remains separate; this slice must not silently weaken its locks or approvals. A bounded local web console exposes persistent text threads and explicitly reviewed memories. Model inference may still go to configured OpenRouter; self-hosted storage does not mean offline inference. Computer actions, bookings, background routines, account connectors and speech are unavailable in this mode.

Server-created anonymous browser sessions are local demo identity, not verified household membership. Session tokens are hashed, HttpOnly/SameSite cookies and write CSRF/Origin checks bind every API request. No request-supplied owner ID is accepted. Owned thread reads, deletion and memory operations must reject another session's IDs with 404. Saved memories enter model context only under that same owner and as untrusted preference data.

SQLite owns threads/messages/run receipts and memories, with foreign keys, WAL/full sync, bounded inputs and transactions. A request has a server-side run ID and client duplicate ID; a duplicate cannot make a second model call. One pending run per owner; restart marks pending runs interrupted without replay. Committed replies survive restart; API errors do not expose provider prompts/keys. No tools capable of external effects are registered. Deletion removes live records, not prior backups/WAL copies or already-downloaded content.

## Acceptance and ordered tasks

1. Storage tests first: ownership, durable restart, duplicate request, conflicting concurrent run, interruption, deletion and memory review/limits.
2. Model/HTTP tests: only free OpenRouter profile, synthetic/injected agent transport; authenticated cookie/CSRF/origin/byte boundaries, no cloud thread/memory call, owner-only model context and provider failure recovery.
3. Local console: actual browser create thread/send/reload, save/delete memory, duplicate-safe run UI, completed history after process restart. Use only synthetic data in automated live tests.
4. Add opt-in self-hosted start/check commands and a no-secret CI job. Preserve upstream tests; record existing failures separately rather than suppressing them.
5. Handoff states precisely what runs and what remains: this starter is not the entire OpenDuet worker/computer feature set. A PostgreSQL backend/full UI integration and production identity/retention/operations follow separately. No GCP deployment or new paid resource is part of this slice.
