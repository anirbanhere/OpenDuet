import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import type { OwnedMedia } from "./media-store";
import { fixtureLanguages, type ProviderRoles } from "./roles";

const inputSchema = z
  .object({
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    media_id: z.uuid(),
    consent_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const roleSchema = z
  .object({
    provider: z.enum(["fixture-a", "fixture-b"]),
    model: z.literal("synthetic-stt-v1"),
    languages: z.array(z.enum(fixtureLanguages)).min(1).max(3),
    timeoutMs: z.number().int().min(1000).max(60000),
  })
  .strict();
export type SttAdmissionLimits = {
  ownerAttempts: number;
  globalAttempts: number;
  ownerAudioMs: number;
  globalAudioMs: number;
  ownerRecords: number;
  globalRecords: number;
};
const defaults: SttAdmissionLimits = {
  ownerAttempts: 4,
  globalAttempts: 20,
  ownerAudioMs: 60000,
  globalAudioMs: 300000,
  ownerRecords: 100,
  globalRecords: 5000,
};
type Row = {
  id: string;
  owner: string;
  request: string;
  digest: string;
  media: string;
  consent_revision: number;
  content_hash: string;
  role: string;
  duration_ms: number;
  language_hint: string | null;
  state: "reserved" | "cancelled" | "interrupted";
  created: number;
  updated: number;
  expires: number;
};

export function migrateSttAdmissions(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS stt_admissions(
    id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    request TEXT NOT NULL, digest TEXT NOT NULL, media TEXT NOT NULL REFERENCES owned_media(id) ON DELETE CASCADE,
    consent_revision INTEGER NOT NULL, content_hash TEXT NOT NULL, role TEXT NOT NULL,
    duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 100 AND 29000), language_hint TEXT,
    state TEXT NOT NULL CHECK(state IN('reserved','cancelled','interrupted')),
    created INTEGER NOT NULL, updated INTEGER NOT NULL, expires INTEGER NOT NULL, UNIQUE(owner,request)
  ); CREATE UNIQUE INDEX IF NOT EXISTS stt_pending_owner ON stt_admissions(owner) WHERE state='reserved';
  CREATE TABLE IF NOT EXISTS stt_admission_usage(id TEXT PRIMARY KEY,owner TEXT NOT NULL,day TEXT NOT NULL,duration_ms INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS stt_usage_day_owner ON stt_admission_usage(day,owner);`);
}

/** Fixture reservations only. No audio, execution lease, transcript or provider call is returned. */
export class SttAdmissions {
  private limits: SttAdmissionLimits;
  constructor(
    private db: Database,
    private media: OwnedMedia,
    private now: () => number = Date.now,
    limits: Partial<SttAdmissionLimits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    for (const key of Object.keys(this.limits) as (keyof SttAdmissionLimits)[])
      if (
        !Number.isInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > defaults[key]
      )
        throw new LocalError("Invalid STT admission budget.");
  }
  private session(owner: string, now: number) {
    if (
      !this.db
        .query("SELECT 1 FROM sessions WHERE owner=? AND expires>? LIMIT 1")
        .get(owner, now)
    )
      throw new LocalError(
        "STT admission requires an active owner session.",
        403,
      );
  }
  private row(owner: string, id: string) {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM stt_admissions WHERE owner=? AND id=?",
      )
      .get(owner, id);
    if (!row) throw new LocalError("STT admission not found.", 404);
    return row;
  }
  private view(row: Row) {
    let role: z.infer<typeof roleSchema>;
    try {
      role = roleSchema.parse(JSON.parse(row.role));
    } catch {
      throw new LocalError("Stored STT admission is unavailable.", 503);
    }
    return {
      id: row.id,
      request_id: row.request,
      mediaId: row.media,
      consentRevision: row.consent_revision,
      mode: "fixture" as const,
      role: Object.freeze({
        ...role,
        languages: Object.freeze(role.languages),
      }),
      durationMs: row.duration_ms,
      languageHint: row.language_hint,
      state: row.state,
      createdAt: row.created,
      updatedAt: row.updated,
      expiresAt: row.expires,
    };
  }
  begin(owner: string, input: unknown, currentRole: ProviderRoles["stt"]) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success)
      throw new LocalError(
        "Use a request ID, owned media ID and exact consent revision only.",
      );
    const digest = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    return this.db
      .transaction(() => {
        const now = this.now();
        this.session(owner, now);
        const duplicate = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM stt_admissions WHERE owner=? AND request=?",
          )
          .get(owner, parsed.data.request_id);
        if (duplicate) {
          if (duplicate.digest !== digest)
            throw new LocalError(
              "STT request conflicts with its original input.",
              409,
            );
          return this.view(duplicate);
        }
        const selected = roleSchema.safeParse(currentRole);
        if (!selected.success)
          throw new LocalError(
            "Only reviewed synthetic fixture STT roles can be admitted; live speech remains disabled.",
            503,
          );
        const consent = this.media.checkProcessingConsent(
            owner,
            parsed.data.media_id,
            parsed.data.consent_revision,
          ),
          metadata = this.media.metadata(owner, parsed.data.media_id);
        if (
          metadata.durationMs < 100 ||
          metadata.durationMs > 29000 ||
          (metadata.languageHint &&
            !(selected.data.languages as readonly string[]).includes(
              metadata.languageHint,
            ))
        )
          throw new LocalError(
            "Media duration/language is unavailable for this STT role.",
          );
        if (
          this.db
            .query(
              "SELECT 1 FROM stt_admissions WHERE owner=? AND state='reserved'",
            )
            .get(owner)
        )
          throw new LocalError(
            "An STT reservation is already pending for this owner.",
            409,
          );
        const lifetime = this.db
          .query<{ total: number; owned: number }, [string]>(
            "SELECT count(*) total,COALESCE(sum(CASE WHEN owner=? THEN 1 ELSE 0 END),0) owned FROM stt_admission_usage",
          )
          .get(owner);
        const day = new Date(now).toISOString().slice(0, 10),
          usage = this.db
            .query<
              { attempts: number; owned: number; ms: number; ownedMs: number },
              [string, string, string]
            >(`SELECT count(*) attempts,COALESCE(sum(CASE WHEN owner=? THEN 1 ELSE 0 END),0) owned,
        COALESCE(sum(duration_ms),0) ms,COALESCE(sum(CASE WHEN owner=? THEN duration_ms ELSE 0 END),0) ownedMs FROM stt_admission_usage WHERE day=?`)
            .get(owner, owner, day);
        if (
          !lifetime ||
          !usage ||
          lifetime.total >= this.limits.globalRecords ||
          lifetime.owned >= this.limits.ownerRecords ||
          usage.attempts >= this.limits.globalAttempts ||
          usage.owned >= this.limits.ownerAttempts ||
          usage.ms + metadata.durationMs > this.limits.globalAudioMs ||
          usage.ownedMs + metadata.durationMs > this.limits.ownerAudioMs
        )
          throw new LocalError("STT admission budget is exhausted.", 429);
        const id = randomUUID();
        this.db
          .query(`INSERT INTO stt_admissions(id,owner,request,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires)
        VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?,?)`)
          .run(
            id,
            owner,
            parsed.data.request_id,
            digest,
            metadata.id,
            consent.consentRevision,
            consent.contentSha256,
            JSON.stringify(selected.data),
            metadata.durationMs,
            metadata.languageHint,
            now,
            now,
            metadata.expiresAt,
          );
        this.db
          .query("INSERT INTO stt_admission_usage VALUES(?,?,?,?)")
          .run(id, owner, day, metadata.durationMs);
        return this.view(this.row(owner, id));
      })
      .immediate();
  }
  get(owner: string, id: string) {
    const row = this.row(owner, id);
    this.session(owner, this.now());
    return this.view(row);
  }
  cancel(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          now = this.now();
        this.session(owner, now);
        if (row.state === "reserved")
          this.db
            .query(
              "UPDATE stt_admissions SET state='cancelled',updated=? WHERE owner=? AND id=?",
            )
            .run(now, owner, id);
        return this.view(this.row(owner, id));
      })
      .immediate();
  }
  /** Call only after the full store's exclusive kernel lock proves the previous server is gone. */
  recoverOnExclusiveStartup() {
    this.db
      .query(
        "UPDATE stt_admissions SET state='interrupted',updated=? WHERE state='reserved'",
      )
      .run(this.now());
  }
}
