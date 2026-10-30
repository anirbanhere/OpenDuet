import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { migrateSttAdmissions } from "../src/self-hosted/stt-admission";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  checks: Database[] = [];
const role = (provider = "fixture-a") =>
  selfHostedConfig({ SAATHI_STT_PROVIDER: provider }).roles.stt;
const inspect = (path: string) => {
  const db = new Database(path);
  checks.push(db);
  return db;
};
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-claims-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite");
  let now = Date.now();
  const open = () => {
    const store = new SelfHostedStore(path, { now: () => now });
    stores.push(store);
    return store;
  };
  const store = open(),
    a = store.createSession(),
    b = store.createSession();
  const media = store.media.admit(a.owner, {
    request_id: "clip",
    audio: syntheticSpeechFixture("en-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "en-IN",
  });
  const input = (request_id = "request") => ({
    request_id,
    media_id: media.id,
    consent_revision: media.consentRevision,
  });
  const admission = store.sttAdmissions.begin(a.owner, input(), role());
  return {
    store,
    path,
    open,
    a,
    b,
    media,
    input,
    admission,
    now: () => now,
    clock: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => {
  for (const db of checks.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-claims-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(folder, { recursive: true, force: true });
  }
});

test("one-shot fixture claim returns audio/token once and status stores/exposes no raw executor credential", () => {
  const w = world(),
    claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  expect(claim.fresh).toBe(true);
  if (!claim.fresh) throw new Error("Expected synthetic claim");
  expect(claim.audio).toEqual(syntheticSpeechFixture("en-IN").audio);
  expect(claim.executorToken).toHaveLength(43);
  expect(claim.admission.state).toBe("claimed");
  expect(claim.admission.pending).toBe(true);
  claim.audio[0] = 0;
  expect(w.store.media.read(w.a.owner, w.media.id)[0]).toBe(82);
  const duplicate = w.store.sttAdmissions.claim(
    w.a.owner,
    w.admission.id,
    role("disabled"),
  );
  expect(duplicate.fresh).toBe(false);
  expect(JSON.stringify(duplicate)).not.toContain("executorToken");
  expect(JSON.stringify(duplicate)).not.toContain('"audio"');
  const status = w.store.sttAdmissions.get(w.a.owner, w.admission.id);
  expect(JSON.stringify(status)).not.toContain(claim.executorToken);
  const saved = inspect(w.path)
    .query<{ claim_hash: string }, [string]>(
      "SELECT claim_hash FROM stt_admissions WHERE id=?",
    )
    .get(w.admission.id);
  expect(saved?.claim_hash).toBe(
    createHash("sha256").update(claim.executorToken).digest("hex"),
  );
  expect(() =>
    w.store.sttAdmissions.claim(w.b.owner, w.admission.id, role()),
  ).toThrow("not found");
});

test("changed role policy, revoked/expired consent and corrupt media fail closed without returning claims", () => {
  const changed = world();
  const denied = changed.store.sttAdmissions.claim(
    changed.a.owner,
    changed.admission.id,
    role("fixture-b"),
  );
  expect(denied.fresh).toBe(false);
  expect(denied.admission.state).toBe("blocked");
  expect(denied.admission.pending).toBe(false);
  expect(
    changed.store.sttAdmissions.claim(
      changed.a.owner,
      changed.admission.id,
      role(),
    ).fresh,
  ).toBe(false);
  const revoked = world();
  revoked.store.media.revokeProcessing(revoked.a.owner, revoked.media.id);
  const stopped = revoked.store.sttAdmissions.claim(
    revoked.a.owner,
    revoked.admission.id,
    role(),
  );
  expect(stopped.fresh).toBe(false);
  expect(stopped.admission.pending).toBe(false);
  const expired = world();
  expired.clock(expired.media.expiresAt);
  expect(
    expired.store.sttAdmissions.claim(
      expired.a.owner,
      expired.admission.id,
      role(),
    ).fresh,
  ).toBe(false);
  const corrupt = world();
  inspect(corrupt.path)
    .query("UPDATE owned_media SET audio=? WHERE id=?")
    .run(new Uint8Array(8044), corrupt.media.id);
  expect(
    corrupt.store.sttAdmissions.claim(
      corrupt.a.owner,
      corrupt.admission.id,
      role(),
    ).fresh,
  ).toBe(false);
});

test("cancelling a claimed task holds its slot until exclusive restart and never reissues audio/token", () => {
  const w = world();
  w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  const cancelled = w.store.sttAdmissions.cancel(w.a.owner, w.admission.id);
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.pending).toBe(true);
  expect(() =>
    w.store.sttAdmissions.begin(w.a.owner, w.input("another"), role()),
  ).toThrow("pending");
  expect(
    w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  w.store.close();
  const reopened = w.open();
  expect(reopened.sttAdmissions.get(w.a.owner, w.admission.id).pending).toBe(
    false,
  );
  expect(reopened.sttAdmissions.get(w.a.owner, w.admission.id).state).toBe(
    "cancelled",
  );
  expect(
    reopened.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  expect(
    inspect(w.path)
      .query<{ claim_hash: string | null }, [string]>(
        "SELECT claim_hash FROM stt_admissions WHERE id=?",
      )
      .get(w.admission.id)?.claim_hash,
  ).toBeNull();
  expect(
    reopened.sttAdmissions.begin(w.a.owner, w.input("another"), role()).state,
  ).toBe("reserved");
});

test("claim deadline clamps to the current session expiry and revocation retains only an in-flight slot", () => {
  const w = world();
  inspect(w.path)
    .query("UPDATE sessions SET expires=? WHERE owner=?")
    .run(w.now() + 500, w.a.owner);
  const claim = w.store.sttAdmissions.claim(w.a.owner, w.admission.id, role());
  expect(claim.admission.claimDeadline).toBe(w.now() + 500);
  w.store.media.revoke(w.a.owner, w.media.id);
  const status = w.store.sttAdmissions.get(w.a.owner, w.admission.id);
  expect(status.state).toBe("revoked");
  expect(status.pending).toBe(true);
});

test("real v10 migration preserves reservations/unit ledger and interrupts old pending work without replay", () => {
  const w = world();
  w.store.close();
  const fixture = inspect(w.path);
  const columns =
    "id,owner,request,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires";
  fixture.exec(
    `DROP TRIGGER IF EXISTS media_invalidates_stt; CREATE TEMP TABLE admission_copy AS SELECT ${columns} FROM stt_admissions; DROP TABLE stt_admissions`,
  );
  migrateSttAdmissions(fixture);
  fixture.exec(
    `INSERT INTO stt_admissions SELECT ${columns} FROM admission_copy; DROP TABLE admission_copy; UPDATE version SET value=10`,
  );
  const migrated = w.open();
  expect(migrated.sttAdmissions.get(w.a.owner, w.admission.id).state).toBe(
    "interrupted",
  );
  expect(
    migrated.sttAdmissions.claim(w.a.owner, w.admission.id, role()).fresh,
  ).toBe(false);
  expect(
    fixture
      .query<{ n: number }, []>("SELECT count(*) n FROM stt_admission_usage")
      .get()?.n,
  ).toBe(1);
  expect(migrated.media.metadata(w.a.owner, w.media.id)).toEqual(w.media);
});
