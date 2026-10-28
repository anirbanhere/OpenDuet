import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class LocalError extends Error {
  constructor(
    message: string,
    public readonly status = 422,
  ) {
    super(message);
  }
}
export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};
type Thread = {
  id: string;
  owner: string;
  agent: string;
  created: number;
  updated: number;
};
type Run = {
  id: string;
  owner: string;
  thread: string;
  request: string;
  digest: string;
  state: "running" | "completed" | "failed" | "interrupted";
  reply: string | null;
  model: string | null;
};
type Memory = { id: string; content: string; created: number };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** SQLite's OS lock releases on process death; no stale PID file or lock-stealing race. */
function ownDatabase(path: string) {
  const lock = new Database(`${path}.lock.sqlite`, { create: true });
  try {
    chmodSync(`${path}.lock.sqlite`, 0o600);
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new LocalError(
      "This local database already has a server or cannot be locked.",
      503,
    );
  }
  return () => lock.close();
}

export class SelfHostedStore {
  private db: Database;
  private release: () => void;
  private closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.release = ownDatabase(path);
    let opened: Database | undefined;
    try {
      this.db = new Database(path, { create: true, strict: true });
      opened = this.db;
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS version (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
        INSERT OR IGNORE INTO version VALUES(1,1);
        CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), agent TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS threads_owner ON threads(owner);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, request TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, reply TEXT, UNIQUE(owner,request));
        CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), content TEXT NOT NULL, created INTEGER NOT NULL);`);
      const version = this.db
        .query<{ value: number }, []>("SELECT value FROM version WHERE id=1")
        .get();
      if (version?.value === 1)
        this.db
          .transaction(() => {
            this.db.exec(
              "ALTER TABLE runs ADD COLUMN model TEXT; UPDATE version SET value=2 WHERE id=1",
            );
          })
          .immediate();
      else if (version?.value !== 2)
        throw new LocalError("Unsupported local schema version.", 503);
      // Single-process lock proves no live writer is using these runs. Never automatically replay.
      this.db.exec("UPDATE runs SET state='interrupted' WHERE state='running'");
    } catch (error) {
      opened?.close();
      this.release();
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.release();
      this.closed = true;
    }
  }
  createSession() {
    return this.db
      .transaction(() => {
        const count = this.db
          .query<{ n: number }, []>("SELECT count(*) n FROM owners")
          .get();
        if (!count)
          throw new LocalError("Local workspace storage is unavailable.", 503);
        if (count.n >= 50)
          throw new LocalError("Local workspace budget reached.", 429);
        const owner = randomUUID(),
          token = randomBytes(32).toString("base64url"),
          csrf = randomBytes(24).toString("base64url");
        this.db.query("INSERT INTO owners VALUES(?)").run(owner);
        this.db
          .query("INSERT INTO sessions VALUES(?,?,?,?)")
          .run(hash(token), owner, csrf, Date.now() + 86_400_000);
        return { owner, token, csrf };
      })
      .immediate();
  }
  session(token: string) {
    return this.db
      .query<{ owner: string; csrf: string }, [string, number]>(
        "SELECT owner,csrf FROM sessions WHERE token=? AND expires>?",
      )
      .get(hash(token), Date.now());
  }
  createThread(owner: string, agent: string) {
    if (!["saathi", "kitchen", "inventory"].includes(agent))
      throw new LocalError("Unknown assistant.");
    return this.db
      .transaction(() => {
        if (this.listThreads(owner).length >= 30)
          throw new LocalError("Local thread budget reached.", 429);
        const id = randomUUID(),
          now = Date.now();
        this.db
          .query("INSERT INTO threads VALUES(?,?,?,?,?)")
          .run(id, owner, agent, now, now);
        return this.thread(owner, id);
      })
      .immediate();
  }
  listThreads(owner: string) {
    return this.db
      .query<Thread, [string]>(
        "SELECT * FROM threads WHERE owner=? ORDER BY updated DESC LIMIT 30",
      )
      .all(owner);
  }
  thread(owner: string, id: string) {
    const row = this.db
      .query<Thread, [string, string]>(
        "SELECT * FROM threads WHERE id=? AND owner=?",
      )
      .get(id, owner);
    if (!row) throw new LocalError("Thread not found.", 404);
    const messages = this.db
      .query<StoredMessage, [string]>(
        "SELECT id,role,content FROM messages WHERE thread=? ORDER BY seq",
      )
      .all(id);
    const lastRun = this.db
      .query<
        { id: string; state: Run["state"]; model: string | null },
        [string]
      >(
        "SELECT id,state,model FROM runs WHERE thread=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id);
    return { ...row, messages, lastRun };
  }
  deleteThread(owner: string, id: string) {
    return this.db
      .transaction(() => {
        this.thread(owner, id);
        if (
          this.db
            .query("SELECT 1 FROM runs WHERE thread=? AND state='running'")
            .get(id)
        )
          throw new LocalError("This thread is still running.", 409);
        this.db
          .query("DELETE FROM threads WHERE id=? AND owner=?")
          .run(id, owner);
      })
      .immediate();
  }
  beginRun(
    owner: string,
    threadId: string,
    request: string,
    text: string,
    model: string | null = null,
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(request) ||
      !text.trim() ||
      text.length > 2000
    )
      throw new LocalError("Use a request ID and1–2000 text characters.");
    return this.db
      .transaction(() => {
        const thread = this.thread(owner, threadId),
          digest = hash(
            model === null
              ? `${threadId}\0${text}`
              : JSON.stringify([threadId, text, model]),
          );
        const prior = this.db
          .query<Run, [string, string]>(
            "SELECT * FROM runs WHERE owner=? AND request=?",
          )
          .get(owner, request);
        if (prior) {
          if (prior.digest !== digest)
            throw new LocalError(
              "Request ID conflicts with an earlier message.",
              409,
            );
          return { ...prior, fresh: false };
        }
        if (
          this.db
            .query("SELECT 1 FROM runs WHERE owner=? AND state='running'")
            .get(owner)
        )
          throw new LocalError(
            "An answer is already running in this workspace.",
            409,
          );
        // Reserve both the new question and its possible answer, even after failures.
        if (thread.messages.length + 2 > 100)
          throw new LocalError("Thread message budget reached.", 429);
        const id = randomUUID();
        this.db
          .query(
            "INSERT INTO runs(id,owner,thread,request,digest,state,reply,model) VALUES(?,?,?,?,?,'running',NULL,?)",
          )
          .run(id, owner, threadId, request, digest, model);
        this.db
          .query("INSERT INTO messages VALUES(?,?,?,?,?)")
          .run(
            randomUUID(),
            threadId,
            "user",
            text.trim(),
            thread.messages.length,
          );
        return {
          id,
          owner,
          thread: threadId,
          request,
          digest,
          state: "running" as const,
          reply: null,
          model,
          fresh: true,
        };
      })
      .immediate();
  }
  completeRun(owner: string, id: string, reply: string) {
    if (!reply.trim() || reply.length > 16000)
      throw new LocalError(
        "The model response exceeded the local answer budget.",
        502,
      );
    this.db
      .transaction(() => {
        const run = this.run(owner, id);
        if (run.state === "completed") return;
        if (run.state !== "running")
          throw new LocalError("This run cannot be completed.", 409);
        const count = this.thread(owner, run.thread).messages.length;
        this.db
          .query("INSERT INTO messages VALUES(?,?,?,?,?)")
          .run(randomUUID(), run.thread, "assistant", reply, count);
        this.db
          .query(
            "UPDATE runs SET state='completed',reply=? WHERE id=? AND owner=?",
          )
          .run(reply, id, owner);
        this.db
          .query("UPDATE threads SET updated=? WHERE id=?")
          .run(Date.now(), run.thread);
      })
      .immediate();
  }
  failRun(owner: string, id: string) {
    this.db
      .query(
        "UPDATE runs SET state='failed' WHERE id=? AND owner=? AND state='running'",
      )
      .run(id, owner);
  }
  run(owner: string, id: string) {
    const row = this.db
      .query<Run, [string, string]>("SELECT * FROM runs WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) throw new LocalError("Run not found.", 404);
    return row;
  }
  memories(owner: string) {
    return this.db
      .query<Memory, [string]>(
        "SELECT id,content,created FROM memories WHERE owner=? ORDER BY created,id LIMIT 20",
      )
      .all(owner);
  }
  saveMemory(owner: string, content: string, reviewed: boolean) {
    if (reviewed !== true)
      throw new LocalError("Explicit memory review is required.", 403);
    if (!content.trim() || content.length > 2000)
      throw new LocalError("Use1–2000 characters for a memory.");
    return this.db
      .transaction(() => {
        if (this.memories(owner).length >= 20)
          throw new LocalError("Memory budget reached.", 429);
        const row = {
          id: randomUUID(),
          content: content.trim(),
          created: Date.now(),
        };
        this.db
          .query("INSERT INTO memories VALUES(?,?,?,?)")
          .run(row.id, owner, row.content, row.created);
        return row;
      })
      .immediate();
  }
  deleteMemory(owner: string, id: string) {
    const result = this.db
      .query("DELETE FROM memories WHERE id=? AND owner=?")
      .run(id, owner);
    if (!result.changes) throw new LocalError("Memory not found.", 404);
  }
}
