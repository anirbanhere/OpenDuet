import { Database } from "bun:sqlite";
import { selfHostedConfig } from "../../src/self-hosted/config";
import { OwnedMedia } from "../../src/self-hosted/media-store";
import { SttAdmissions } from "../../src/self-hosted/stt-admission";

const [path, owner, id] = process.argv.slice(2);
if (!path || !owner || !id)
  throw new Error("Missing synthetic claim arguments");
const db = new Database(path, { create: false, strict: true });
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
console.log("ready");
await new Response(Bun.stdin.stream()).text();
try {
  const claims = new SttAdmissions(db, new OwnedMedia(db));
  const result = claims.claim(
    owner,
    id,
    selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles.stt,
  );
  console.log(
    JSON.stringify({
      fresh: result.fresh,
      audioReturned: "audio" in result,
      tokenReturned: "executorToken" in result,
    }),
  );
} finally {
  db.close();
}
