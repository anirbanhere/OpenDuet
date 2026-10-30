import { Database } from "bun:sqlite";
import { selfHostedConfig } from "../../src/self-hosted/config";
import { LocalError } from "../../src/self-hosted/errors";
import { OwnedMedia } from "../../src/self-hosted/media-store";
import { SttAdmissions } from "../../src/self-hosted/stt-admission";

const [path, owner, mediaId, request] = process.argv.slice(2);
if (!path || !owner || !mediaId || !request)
  throw new Error("Missing synthetic contender arguments");
const db = new Database(path, { create: false, strict: true });
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
console.log("ready");
await new Response(Bun.stdin.stream()).text();
try {
  const admissions = new SttAdmissions(db, new OwnedMedia(db));
  const row = admissions.begin(
    owner,
    { request_id: request, media_id: mediaId, consent_revision: 1 },
    selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles.stt,
  );
  console.log(JSON.stringify({ status: "ok", id: row.id }));
} catch (error) {
  if (!(error instanceof LocalError) || ![409, 429].includes(error.status))
    throw new Error("Unexpected synthetic STT admission failure");
  console.log(JSON.stringify({ status: "blocked" }));
} finally {
  db.close();
}
