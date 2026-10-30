import type { Database } from "bun:sqlite";
import { LocalError } from "./errors";

export type ConsentEventKind =
  | "stored"
  | "processing_revoked"
  | "deleted"
  | "storage_revoked"
  | "expired"
  | "migrated_snapshot";
export function migrateMediaConsent(db: Database, now: number) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new LocalError("Invalid consent observation time.", 503);
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(owned_media)")
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("consent_revision"))
    db.exec(
      "ALTER TABLE owned_media ADD COLUMN consent_revision INTEGER NOT NULL DEFAULT 1 CHECK(consent_revision>=1)",
    );
  if (!columns.has("consent_changed_at"))
    db.exec("ALTER TABLE owned_media ADD COLUMN consent_changed_at INTEGER");
  db.exec(`CREATE TABLE IF NOT EXISTS media_consent_events(
    media TEXT NOT NULL REFERENCES owned_media(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision>=1),
    kind TEXT NOT NULL CHECK(kind IN('stored','processing_revoked','deleted','storage_revoked','expired','migrated_snapshot')),
    at INTEGER NOT NULL, storage_consent INTEGER NOT NULL CHECK(storage_consent IN(0,1)),
    processing_consent INTEGER NOT NULL CHECK(processing_consent IN(0,1)), state TEXT NOT NULL,
    PRIMARY KEY(media,revision)
  )`);
  // A migrated snapshot records only observed current state; old consent history is unknown.
  db.query(`INSERT OR IGNORE INTO media_consent_events(media,revision,kind,at,storage_consent,processing_consent,state)
    SELECT id,consent_revision,'migrated_snapshot',?,storage_consent,processing_consent,state FROM owned_media`).run(
    now,
  );
}

/** Caller must include the media transition and event in the same transaction. */
export function appendMediaConsent(
  db: Database,
  id: string,
  kind: ConsentEventKind,
  at: number,
) {
  const result = db
    .query(`INSERT INTO media_consent_events(media,revision,kind,at,storage_consent,processing_consent,state)
    SELECT id,consent_revision,?,?,storage_consent,processing_consent,state FROM owned_media WHERE id=?`)
    .run(kind, at, id);
  if (result.changes !== 1)
    throw new LocalError("Consent history could not be recorded.", 503);
}

export function mediaConsentHistory(db: Database, id: string) {
  return db
    .query<
      {
        revision: number;
        kind: ConsentEventKind;
        at: number;
        storage_consent: number;
        processing_consent: number;
        state: string;
      },
      [string]
    >(
      "SELECT revision,kind,at,storage_consent,processing_consent,state FROM media_consent_events WHERE media=? ORDER BY revision",
    )
    .all(id)
    .map((row) => ({
      revision: row.revision,
      kind: row.kind,
      at: row.at,
      consentToStore: row.storage_consent === 1,
      consentToProcess: row.processing_consent === 1,
      state: row.state,
    }));
}
