# Internal owned-media store

The schema8 foundation adds `owned_media`; schema9 records [consent history](media-consent.md) and current schema11 adds [private fixture claims/settlement](stt-claims.md). `SelfHostedStore.media` is internal: no HTTP upload/playback endpoint, channel, provider registration or background cleanup is added. Tests use fresh synthetic state/generated tones only. Last verified public deployment is schema7; do not start this branch against a private profile or deploy without a separate backed-up upgrade. Older binaries refuse11; never fake the version row or restore an old snapshot over later data.

The caller authenticates the owner through the existing server session boundary. Owner IDs are not authentication credentials and cannot be accepted from request bodies. Admission separately resolves an active session expiry from SQLite and invokes the strict WAV contract. Clip expiry is at most15 minutes and never extends beyond that session. Storage consent must be literal true; processing consent is independently recorded and defaults false. A stored processing-consent flag is not provider access, a processing lease, cost admission or permission to perform a task.

| Internal method | Behavior |
| --- | --- |
| admit(owner,input) | Atomic quota/identity check and bounded WAV BLOB insert; returns metadata only |
| metadata(owner,id) | Owned metadata and effective expiry state; no audio bytes |
| read(owner,id) | Active session/owner/storage consent/state/expiry checks, WAV/duration/hash validation and a fresh byte copy |
| readConsentedSnapshot(owner,id,revision,hash) | Current processing consent and pinned digest plus validated bytes in one read snapshot; repeatable, not an execution lease/token/budget grant |
| revokeProcessing(owner,id) | Clears processing consent without revoking owner playback; duplicates cannot regrant it |
| remove / revoke(owner,id) | Clears the active BLOB and both consent flags; retains the first terminal tombstone |
| purgeExpired() | Explicit operator-only cleanup clears expired active BLOBs; no route or scheduler invokes it |

Admission uses `UNIQUE(owner,request)` and a write transaction before counting quotas. Exact duplicates return their original ID/deadline and current terminal/consent state; changed bytes, locale or processing consent conflict409. Replaying the original request cannot revive deleted/revoked/cleaned content or undo processing revocation. Returned audio bytes are detached from SQLite/caller buffers. A later revocation blocks new reads; bytes already returned to a caller cannot be recalled.

Defaults:10 active BLOBs/20MB per owner and100MB global BLOB bytes. Expired BLOBs still count until explicitly cleared. Lifetime100 records/owner and5,000 global records bound tombstone churn. Internal test overrides can only tighten these limits. These ceilings bound logical rows/current BLOBs, not physical database/WAL/backup size. Metadata retains original size, request identity/digests, locale and lifecycle timestamps for idempotency; this is not full account erasure or secure audio deletion. No claim of secure erasure, provider deletion, backup removal or unattended cleanup is made.

SQLite's immediate transactions serialize quota admission and duplicate decisions across connections. The existing kernel lock still prevents a second full server from taking over a live database. Read transactions check one consistent snapshot; explicit mutation clears the active BLOB atomically. Tests use two coordinated child processes to prove one competing quota admission wins and simultaneous exact duplicates share one row. [Bun SQLite transactions/BLOB API](https://bun.sh/docs/runtime/sqlite), [SQLite isolation](https://www.sqlite.org/isolation.html).

The additive migration preserves existing chat/preferences, inference usage and approved MOCK bookings; existing planning/read tests also run against the new schema. No public/private migration was performed by these tests. Pending before public voice: authorized routes and consent UX, request admission/dedup/spend, processing/revocation leases and restart handling, broader codecs/transcoding, operational retention/backup lifecycle and real consented language/provider evaluation. No live speech, WhatsApp, transaction or message delivery is enabled.
