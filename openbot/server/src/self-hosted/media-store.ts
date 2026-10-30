import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { LocalError } from "./errors";
import { appendMediaConsent, mediaConsentHistory } from "./media-consent";
import { prepareMedia } from "./media-contract";
import type { SpeechLanguage } from "./roles";
import { inspectPcmWav } from "./wav";

export type MediaLimits = {
  ownerClips: number;
  ownerBytes: number;
  globalBytes: number;
  ownerRecords: number;
  globalRecords: number;
};
const defaults: MediaLimits = {
  ownerClips: 10,
  ownerBytes: 20_000_000,
  globalBytes: 100_000_000,
  ownerRecords: 100,
  globalRecords: 5000,
};
type State = "active" | "expired" | "deleted" | "revoked";
type Row = {
  id: string;
  owner: string;
  request: string;
  digest: string;
  content_hash: string;
  audio: Uint8Array | null;
  byte_length: number;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  language: SpeechLanguage | null;
  storage_consent: number;
  processing_consent: number;
  state: State;
  created: number;
  expires: number;
  removed: number | null;
  consent_revision: number;
  consent_changed_at: number | null;
};
export function migrateMedia(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS owned_media(
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    request TEXT NOT NULL, digest TEXT NOT NULL, content_hash TEXT NOT NULL, audio BLOB,
    byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 44 AND 2000000),
    duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 1 AND 60000),
    sample_rate INTEGER NOT NULL, channels INTEGER NOT NULL,
    language TEXT, storage_consent INTEGER NOT NULL CHECK(storage_consent IN(0,1)),
    processing_consent INTEGER NOT NULL CHECK(processing_consent IN(0,1)),
    state TEXT NOT NULL CHECK(state IN('active','expired','deleted','revoked')),
    created INTEGER NOT NULL, expires INTEGER NOT NULL CHECK(expires>created), removed INTEGER,
    UNIQUE(owner,request), CHECK((state='active' AND audio IS NOT NULL AND storage_consent=1) OR (state!='active' AND audio IS NULL))
  ); CREATE INDEX IF NOT EXISTS media_owner ON owned_media(owner); CREATE INDEX IF NOT EXISTS media_expiry ON owned_media(state,expires);`);
}

/** Internal only. Caller authenticates owner; no channel/provider/processing lease is supplied. */
export class OwnedMedia {
  private limits: MediaLimits;
  constructor(
    private db: Database,
    private now: () => number = Date.now,
    limits: Partial<MediaLimits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    for (const key of Object.keys(this.limits) as (keyof MediaLimits)[])
      if (
        !Number.isInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > defaults[key]
      )
        throw new LocalError("Invalid media storage budget.");
  }
  private sessionExpiry(owner: string, now: number) {
    const result = this.db
      .query<{ expiry: number | null }, [string, number]>(
        "SELECT max(expires) expiry FROM sessions WHERE owner=? AND expires>?",
      )
      .get(owner, now);
    if (!result?.expiry)
      throw new LocalError("Media requires an active owner session.", 403);
    return result.expiry;
  }
  private row(owner: string, id: string): Row {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM owned_media WHERE owner=? AND id=?",
      )
      .get(owner, id);
    if (!row) throw new LocalError("Media not found.", 404);
    return row;
  }
  private view(row: Row, now: number) {
    return {
      id: row.id,
      request_id: row.request,
      state:
        row.state === "active" && row.expires <= now
          ? ("expired" as const)
          : row.state,
      mimeType: "audio/wav" as const,
      byteLength: row.byte_length,
      durationMs: row.duration_ms,
      sampleRate: row.sample_rate,
      channels: row.channels,
      languageHint: row.language,
      consentToStore: row.storage_consent === 1,
      consentToProcess: row.processing_consent === 1,
      createdAt: row.created,
      expiresAt: row.expires,
      removedAt: row.removed,
      consentRevision: row.consent_revision,
      consentChangedAt: row.consent_changed_at,
    };
  }
  admit(owner: string, input: unknown) {
    return this.db
      .transaction(() => {
        const now = this.now(),
          expiry = this.sessionExpiry(owner, now),
          prepared = prepareMedia(
            { owner, now, sessionExpiresAt: expiry },
            input,
          );
        const duplicate = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM owned_media WHERE owner=? AND request=?",
          )
          .get(owner, prepared.request_id);
        if (duplicate) {
          if (duplicate.digest !== prepared.requestDigest)
            throw new LocalError(
              "Media request conflicts with its original input.",
              409,
            );
          return this.view(duplicate, now);
        }
        const usage = this.db
          .query<
            {
              totalBytes: number;
              ownerBytes: number;
              clips: number;
              records: number;
              ownerRecords: number;
            },
            [string, string, string]
          >(`SELECT COALESCE(sum(length(audio)),0) totalBytes,
        COALESCE(sum(CASE WHEN owner=? THEN length(audio) ELSE 0 END),0) ownerBytes,
        COALESCE(sum(CASE WHEN owner=? AND audio IS NOT NULL THEN 1 ELSE 0 END),0) clips,
        count(*) records, COALESCE(sum(CASE WHEN owner=? THEN 1 ELSE 0 END),0) ownerRecords FROM owned_media`)
          .get(owner, owner, owner);
        if (
          !usage ||
          usage.totalBytes + prepared.byteLength > this.limits.globalBytes ||
          usage.ownerBytes + prepared.byteLength > this.limits.ownerBytes ||
          usage.clips >= this.limits.ownerClips ||
          usage.records >= this.limits.globalRecords ||
          usage.ownerRecords >= this.limits.ownerRecords
        )
          throw new LocalError("Media storage budget is exhausted.", 429);
        const id = randomUUID();
        this.db
          .query(`INSERT INTO owned_media(id,owner,request,digest,content_hash,audio,byte_length,duration_ms,sample_rate,channels,language,storage_consent,processing_consent,state,created,expires,removed,consent_revision,consent_changed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,'active',?,?,NULL,1,?)`)
          .run(
            id,
            owner,
            prepared.request_id,
            prepared.requestDigest,
            prepared.contentSha256,
            prepared.audio,
            prepared.byteLength,
            prepared.durationMs,
            prepared.sampleRate,
            prepared.channels,
            prepared.languageHint,
            prepared.consentToProcess ? 1 : 0,
            now,
            prepared.expiresAt,
            now,
          );
        appendMediaConsent(this.db, id, "stored", now);
        return this.view(this.row(owner, id), now);
      })
      .immediate();
  }
  metadata(owner: string, id: string) {
    const row = this.row(owner, id),
      now = this.now();
    this.sessionExpiry(owner, now);
    return this.view(row, now);
  }
  read(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          now = this.now();
        this.sessionExpiry(owner, now);
        if (
          row.state !== "active" ||
          !row.storage_consent ||
          row.expires <= now ||
          !row.audio
        )
          throw new LocalError("Stored media is unavailable.", 410);
        const bytes = Uint8Array.from(row.audio);
        try {
          const wav = inspectPcmWav(bytes);
          if (
            bytes.length !== row.byte_length ||
            Math.ceil(wav.durationMs) !== row.duration_ms ||
            wav.sampleRate !== row.sample_rate ||
            wav.channels !== row.channels ||
            createHash("sha256").update(bytes).digest("hex") !==
              row.content_hash
          )
            throw new Error("Invalid media");
        } catch {
          throw new LocalError("Stored media is unavailable.", 502);
        }
        return bytes;
      })
      .deferred();
  }
  consentHistory(owner: string, id: string) {
    return this.db
      .transaction(() => {
        this.row(owner, id);
        this.sessionExpiry(owner, this.now());
        return mediaConsentHistory(this.db, id);
      })
      .deferred();
  }
  /** Read-only consent snapshot. No audio, processing lease or execution grant is returned. */
  checkProcessingConsent(owner: string, id: string, expectedRevision: number) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new LocalError("Use a valid consent revision.");
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          now = this.now();
        this.sessionExpiry(owner, now);
        if (
          row.state !== "active" ||
          !row.storage_consent ||
          row.expires <= now ||
          !row.audio
        )
          throw new LocalError("Stored media is unavailable.", 410);
        if (row.consent_revision !== expectedRevision)
          throw new LocalError(
            "Media consent changed; review the current revision.",
            409,
          );
        if (!row.processing_consent)
          throw new LocalError(
            "Current media processing consent is required.",
            403,
          );
        return {
          mediaId: row.id,
          consentRevision: row.consent_revision,
          contentSha256: row.content_hash,
          checkedAt: now,
          expiresAt: row.expires,
        };
      })
      .deferred();
  }
  private destroy(owner: string, id: string, state: "deleted" | "revoked") {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          now = this.now();
        this.sessionExpiry(owner, now);
        if (row.state === "active") {
          this.db
            .query(
              "UPDATE owned_media SET audio=NULL,state=?,storage_consent=0,processing_consent=0,removed=?,consent_revision=consent_revision+1,consent_changed_at=? WHERE owner=? AND id=?",
            )
            .run(state, now, now, owner, id);
          appendMediaConsent(
            this.db,
            id,
            state === "deleted" ? "deleted" : "storage_revoked",
            now,
          );
        }
        return this.view(this.row(owner, id), now);
      })
      .immediate();
  }
  remove(owner: string, id: string) {
    return this.destroy(owner, id, "deleted");
  }
  revoke(owner: string, id: string) {
    return this.destroy(owner, id, "revoked");
  }
  revokeProcessing(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        const now = this.now();
        this.sessionExpiry(owner, now);
        if (row.state === "active" && row.processing_consent) {
          this.db
            .query(
              "UPDATE owned_media SET processing_consent=0,consent_revision=consent_revision+1,consent_changed_at=? WHERE owner=? AND id=?",
            )
            .run(now, owner, id);
          appendMediaConsent(this.db, id, "processing_revoked", now);
        }
        return this.view(this.row(owner, id), now);
      })
      .immediate();
  }
  /** Operator-only explicit cleanup; never exposed to anonymous channel dispatch. */
  purgeExpired() {
    return this.db
      .transaction(() => {
        const now = this.now(),
          rows = this.db
            .query<{ id: string }, [number]>(
              "SELECT id FROM owned_media WHERE state='active' AND expires<=?",
            )
            .all(now);
        this.db
          .query(
            "UPDATE owned_media SET audio=NULL,state='expired',storage_consent=0,processing_consent=0,removed=?,consent_revision=consent_revision+1,consent_changed_at=? WHERE state='active' AND expires<=?",
          )
          .run(now, now, now);
        for (const row of rows)
          appendMediaConsent(this.db, row.id, "expired", now);
        return rows.length;
      })
      .immediate();
  }
}
