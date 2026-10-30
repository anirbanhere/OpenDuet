# Local owned-media controls

The self-hosted app has an explicit loopback-only opt-in for metadata and revocation/deletion of already-stored media. This is a control boundary, not an upload, playback, speech or task-execution API. Default is off. No existing private/public database has been opened or migrated by this work; schema remains11. An existing schema7 demo/profile needs a separate consistent backed-up upgrade before a newer binary may open it. Never change the version row to bypass this.

`SAATHI_LOCAL_MEDIA_CONTROLS` accepts only `true` or `false` and defaults false. Configuration rejects true together with `SAATHI_PUBLIC_ORIGIN`. The app independently registers nothing in public-origin mode even when a programmatic caller passes `localMediaControls: true`. The native entry passes the parsed flag; it does not infer permission from a configured speech model or key. This setting does not enable live speech/actions or override spend/consent gates.

Routes are attached after the existing parent host/session/JSON/CSRF/security middleware, preserving the global60KB body and request-rate limits. This follows Hono's [registration order](https://hono.dev/docs/guides/middleware#execution-order) and [routing API](https://hono.dev/docs/api/routing); no new authentication, CORS or cookie flow is introduced. Anonymous requests are rejected by the parent API guard, including for unknown routes; an authenticated caller sees404 when these routes are not registered.

| Method and path | Input | Output/effect |
| --- | --- | --- |
| GET /api/media/:id | UUID only; no query fields | Owned metadata/effective expiry state, no audio/transcript/token/hash/owner identifier |
| POST /api/media/:id/revoke-processing | Same-origin JSON exactly `{}` plus existing CSRF | Atomically clear processing consent/linked retained text; return metadata |
| DELETE /api/media/:id | Same-origin JSON exactly `{}` plus existing CSRF | Atomically clear active BLOB/both consent flags/linked retained text; return terminal metadata |

Identity comes from the active server session, never a body/query owner. Foreign/unknown valid IDs return404; malformed IDs/query/body extensions return422. Missing/expired sessions and origin/CSRF failures retain existing401/403 behavior. Body overflow is413 and malformed JSON400. Unexpected storage failures return the existing sanitized503 without provider/SQLite details. Responses keep no-store and security headers.

Metadata retains original size/language/request identity, consent flags/revision and lifecycle timestamps. An effective `expired` state can coexist with historical true flags and bytes still stored until explicit cleanup. These recorded flags are not a fresh processing grant or assurance of availability. Exact repeated revoke/delete preserves original revision/tombstone; replay cannot regrant consent or revive content. This is logical clearing, not secure erasure of WAL, backups or already-returned copies.

The store's atomic media trigger invalidates linked private STT output. An already-handed-out worker still holds its pending slot until private acknowledgement or exclusive restart. HTTP media revocation has no shared cancellation bus and cannot recall audio or forcibly stop a worker. No raw executor capability or transcript is returned by these routes.

`GET /health` reports `local_media_controls` separately; `speech` and `actions` stay false. There is no HTTP media creation/list/upload/download/playback/history/cleanup/consent-grant/transcribe/claim/settlement endpoint. The fixture CLI remains a separate fresh-temporary-state demonstration. No model/provider request is made by a media control; synthetic tests explicitly seed owned media/results in process.

Verification covers omitted/false/public opt-in, strict config, owner/session/CSRF/origin, UUID/query/body/byte limits, expiry versus physical retention, exact repeated mutations, saved-output clearing, in-flight slot retention and rollback/sanitized storage failure. The packed public-mode smoke additionally proves the three routes are absent and speech remains false. No recordings, keys, existing profiles or real provider calls are used. This is partial FR-007/034 infrastructure, not completed public voice or full data erasure.

Next: an explicit local metadata/consent-status UI and operator lifecycle. New uploads/recordings need their own bounded transport and consent UX; public/live speech, provider budgets/access and actual consented Indic evaluation remain separate gates. Do not enable this flag on the current private profile merely to try the code; use a fresh task-specific database or the keyless fixture command until the reviewed upgrade is performed.
