import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../.."),
  build = join(root, "artifacts/public-build");
const folder = mkdtempSync(join(tmpdir(), "saathi-bundle-"));
if (
  dirname(resolve(folder)) !== resolve(tmpdir()) ||
  !basename(folder).startsWith("saathi-bundle-")
)
  throw new Error("Unsafe test cleanup target");
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = probe.port;
assert(port);
probe.stop(true);
const base = `http://127.0.0.1:${port}`,
  origin = "https://demo.example.test";
const child = Bun.spawn([process.execPath, join(build, "app.js")], {
  cwd: build,
  stdout: "ignore",
  stderr: "pipe",
  env: {
    ...process.env,
    META_API_KEY: "",
    MODEL_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENAI_API_KEY: "",
    INTELLIGENCE_API_KEY: "",
    CPK_INTELLIGENCE_API_KEY: "",
    SAATHI_ENABLE_META: "false",
    SAATHI_PUBLIC_ORIGIN: origin,
    SAATHI_DATABASE_PATH: join(folder, "state.sqlite"),
    SAATHI_TENANT_PATH: join(build, "examples/saathi"),
    SAATHI_WEB_ROOT: join(build, "saathi-web"),
    SAATHI_PORT: String(port),
  },
});
const request = (path: string, init: RequestInit = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      Host: "demo.example.test",
      Origin: origin,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(5000),
  });
const sessionCookie = (response: Response) => {
  const value = response.headers.get("set-cookie")?.split(";")[0];
  assert(value);
  return value;
};
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      ready = (await request("/health")).ok;
    } catch {}
    if (ready) break;
    await Bun.sleep(125);
  }
  assert(ready, "Bundle did not start");
  const health = await (await request("/health")).json();
  assert.equal(health.public_demo, true);
  assert.deepEqual(health.daily_limits, { global: 20, owner: 5 });
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("strict-transport-security"), "max-age=86400");
  assert((await page.text()).includes("Reply model"));
  assert.equal((await request("/assets/app.js")).status, 200);
  const session = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(session.status, 201);
  assert(session.headers.get("set-cookie")?.includes("Secure"));
  const cookie = sessionCookie(session),
    data = await session.json();
  const thread = await request("/api/threads", {
    method: "POST",
    headers: { Cookie: cookie, "X-Saathi-CSRF": data.csrf },
    body: JSON.stringify({ agent: "saathi" }),
  });
  assert.equal(thread.status, 201);
  const { id } = await thread.json();
  const other = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(
    (
      await request(`/api/threads/${id}`, {
        headers: { Cookie: sessionCookie(other) },
      })
    ).status,
    404,
  );
  child.kill();
  await child.exited;
  const db = new Database(join(folder, "state.sqlite"), { readonly: true });
  try {
    assert.equal(
      (db.query("SELECT count(*) n FROM threads").get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
  console.log(
    "Packed public service passed: boot, assets, Secure session, ownership and durable database. No model calls.",
  );
} finally {
  child.kill();
  await child.exited;
  rmSync(folder, { recursive: true, force: true });
}
