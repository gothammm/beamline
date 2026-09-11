import { Database } from "bun:sqlite";

export interface Agent {
  id: string;
  name: string;
}
export interface Message {
  seq: number;
  from_id: string;
  to_id: string | null; // null = broadcast
  thread_id: string | null;
  body: string;
}

const NAMES = [
  "Apollo", "Astra", "Breeze", "Comet", "Dune", "Echo",
  "Flint", "Grove", "Halo", "Iris", "Jade", "Kite",
  "Luna", "Moss", "Nova", "Onyx", "Piper", "Quartz",
  "River", "Sol",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openStore(dbPath: string) {
  const db = new Database(dbPath, { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
      to_id TEXT, thread_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS cursors (
      agent_id TEXT PRIMARY KEY, upto_seq INTEGER NOT NULL DEFAULT 0);`);
  // Migration: quiet flag for log-without-wake (pre-v0.3 rows read as non-quiet).
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0`);
  } catch {
    /* column already there */
  }

  const qAgent = db.query("SELECT id, name FROM agents WHERE id = ?");
  const qNameTaken = db.query("SELECT 1 FROM agents WHERE name = ?");

  function register(name?: string): Agent {
    name ??= NAMES[Math.floor(Math.random() * NAMES.length)];
    if (qNameTaken.get(name)) name = `${name}-${crypto.randomUUID().slice(0, 4)}`;
    const id = `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 4)}`;
    db.query("INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, Date.now());
    // New agents start past historic broadcasts — no replay of mail from before they joined.
    db.query("INSERT OR IGNORE INTO cursors (agent_id, upto_seq) VALUES (?, (SELECT COALESCE(MAX(seq), 0) FROM messages))").run(id);
    return { id, name };
  }

  function agent(id: string): Agent | null {
    return (qAgent.get(id) as Agent) ?? null;
  }

  function listAgents(): Agent[] {
    return db.query("SELECT id, name FROM agents ORDER BY created_at").all() as Agent[];
  }

  function send(from_id: string, to_id: string, body: string, thread_id?: string): Message {
    if (!agent(from_id)) throw new Error(`unknown sender: ${from_id}`);
    if (!agent(to_id)) throw new Error(`unknown recipient: ${to_id}`);
    db.query(
      "INSERT INTO messages (from_id, to_id, thread_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(from_id, to_id, thread_id ?? null, body, Date.now());
    return db.query("SELECT seq, from_id, to_id, thread_id, body FROM messages WHERE seq = last_insert_rowid()").get() as Message;
  }

  function broadcast(from_id: string, body: string, thread_id?: string): Message {
    if (!agent(from_id)) throw new Error(`unknown sender: ${from_id}`);
    db.query(
      "INSERT INTO messages (from_id, to_id, thread_id, body, created_at) VALUES (?, NULL, ?, ?, ?)",
    ).run(from_id, thread_id ?? null, body, Date.now());
    return db.query("SELECT seq, from_id, to_id, thread_id, body FROM messages WHERE seq = last_insert_rowid()").get() as Message;
  }

  function cursor(agent_id: string): number {
    return (db.query("SELECT upto_seq FROM cursors WHERE agent_id = ?").get(agent_id) as { upto_seq: number } | null)?.upto_seq ?? 0;
  }

  // Log-without-wake: recorded for explicit reads, never injected by wake paths.
  // to_id omitted = every agent; set = one peer's FYI. Fire-and-forget — the
  // wake path may ack past quiet seqs, so guaranteed delivery needs send().
  function log(from_id: string, body: string, to_id?: string, thread_id?: string): Message {
    if (!agent(from_id)) throw new Error(`unknown sender: ${from_id}`);
    if (to_id && !agent(to_id)) throw new Error(`unknown recipient: ${to_id}`);
    db.query(
      "INSERT INTO messages (from_id, to_id, thread_id, body, quiet, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(from_id, to_id ?? null, thread_id ?? null, body, Date.now());
    return db.query("SELECT seq, from_id, to_id, thread_id, body FROM messages WHERE seq = last_insert_rowid()").get() as Message;
  }

  function poll(agent_id: string, after_seq?: number, includeQuiet = false): Message[] {
    const after = after_seq ?? cursor(agent_id);
    return db.query(
      "SELECT seq, from_id, to_id, thread_id, body FROM messages WHERE seq > ? AND (to_id = ? OR to_id IS NULL) AND (quiet = 0 OR ? = 1) ORDER BY seq",
    ).all(after, agent_id, includeQuiet ? 1 : 0) as Message[];
  }

  // ponytail: sleep-poll loop, ceiling is ~250ms latency + one wake per agent;
  // upgrade to pub/sub notify (SSE/broker) when multi-host or sub-100ms matters.
  async function wait(agent_id: string, after_seq?: number, timeout_ms = 30000, includeQuiet = false): Promise<Message[]> {
    const deadline = Date.now() + timeout_ms;
    for (;;) {
      const rows = poll(agent_id, after_seq, includeQuiet);
      if (rows.length || Date.now() >= deadline) return rows;
      await sleep(250);
    }
  }

  function ack(agent_id: string, upto_seq: number): void {
    db.query("INSERT INTO cursors (agent_id, upto_seq) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET upto_seq = max(upto_seq, ?)").run(
      agent_id,
      upto_seq,
      upto_seq,
    );
  }

  function unregister(agent_id: string): boolean {
    // Reap pending directs to the dead agent (broadcasts are shared history — kept).
    db.query("DELETE FROM messages WHERE to_id = ?").run(agent_id);
    db.query("DELETE FROM cursors WHERE agent_id = ?").run(agent_id);
    const r = db.query("DELETE FROM agents WHERE id = ?").run(agent_id);
    return r.changes > 0;
  }

  return { register, agent, listAgents, send, broadcast, log, poll, wait, ack, cursor, unregister };
}

export type Store = ReturnType<typeof openStore>;
