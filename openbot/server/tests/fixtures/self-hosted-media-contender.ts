import { Database } from "bun:sqlite";
import { LocalError } from "../../src/self-hosted/errors";
import { OwnedMedia } from "../../src/self-hosted/media-store";
import { syntheticSpeechFixture } from "../../src/self-hosted/speech";

const [path, owner, request_id] = process.argv.slice(2);
if (!path || !owner || !request_id)
  throw new Error("Missing synthetic fixture arguments");
const db = new Database(path, { create: false, strict: true });
db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
console.log("ready");
await new Response(Bun.stdin.stream()).text();
try {
  const media = new OwnedMedia(db, Date.now, { ownerClips: 1 });
  const saved = media.admit(owner, {
    request_id,
    audio: syntheticSpeechFixture("en-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
  });
  console.log(JSON.stringify({ status: "ok", id: saved.id }));
} catch (error) {
  if (!(error instanceof LocalError) || error.status !== 429)
    throw new Error("Synthetic admission failed unexpectedly");
  console.log(JSON.stringify({ status: "quota" }));
} finally {
  db.close();
}
