// Beamline wake plugin for OpenCode. Installed once per machine by
// `beamline init --global` → ~/.config/opencode/plugins/beamline.js.
// - session.created: auto-register this session (name+id) and link it.
// - session.deleted: unlink + remove the agent from the bus.
// - session.idle (fast path) + background poller (backstop): poll beamline for
//   this session's agent; inject mail as a prompt. The poller is what wakes a
//   session parked at a prompt — idle events alone don't fire there, so a send
//   would otherwise sit unread until the user nudges the session.
// Identity resolves via .beamline/sessions/<session-id>; $BEAMLINE_AGENT overrides.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sh = (args, cwd) => {
  const proc = Bun.spawnSync(args, { cwd });
  return new TextDecoder().decode(proc.stdout);
};

export const BeamlinePlugin = async ({ client, directory }) => {
  // ponytail: shell out to the installed CLI instead of importing store.ts, so the
  // plugin stays dependency-free and never diverges from CLI/MCP behavior.
  const CLI = process.env.BEAMLINE_HOME ? join(process.env.BEAMLINE_HOME, "src", "cli.ts") : null;
  const run = (sub, extra = []) => sh(CLI ? ["bun", CLI, sub, ...extra] : ["beamline", sub, ...extra], directory);

  const log = (o) => {
    try {
      appendFileSync(join(directory, ".beamline", "oc-events.log"), JSON.stringify(o) + "\n");
    } catch {}
  };

  const sidOf = (event) => {
    const p = event.properties ?? {};
    return p.sessionID ?? p.sessionId ?? p.session_id ?? p.id;
  };

  // ponytail: in-process guard only; ceiling is multi-process duplicate
  // prompts (two OC servers, same workspace) — add a lockfile if that ever happens.
  const inflight = new Set();

  // Sessions this server owns (seen via its own events) + last activity per
  // session. The poller only wakes sessions quiet for QUIET_MS so it never
  // interrupts a session that's actively working.
  const known = new Set();
  const lastActivity = new Map();
  const num = (v, dflt) => {
    const n = Number(v);
    return v !== undefined && v !== "" && !Number.isNaN(n) ? n : dflt;
  };
  const POLL_MS = Math.max(250, num(process.env.BEAMLINE_POLL_MS, 5000));
  const QUIET_MS = Math.max(0, num(process.env.BEAMLINE_QUIET_MS, 10000));

  const checkSession = async (sessionID) => {
    if (inflight.has(sessionID)) return;
    inflight.add(sessionID);
    try {
      let agent = process.env.BEAMLINE_AGENT;
      if (!agent) {
        // Link files are JSON {id, pid, updated} with bare-id read compat.
        const link = join(directory, ".beamline", "sessions", String(sessionID));
        if (existsSync(link)) {
          const raw = readFileSync(link, "utf8").trim();
          try {
            agent = raw.startsWith("{") ? JSON.parse(raw).id || "" : raw;
          } catch {
            agent = raw;
          }
        }
      }
      if (!agent) return;
      const mail = JSON.parse(run("poll", ["--agent", agent]) || "[]");
      if (!mail.length) return;
      const body = mail
        .slice(0, 20)
        .map((m) => `📨 from ${m.from_id}${m.thread_id ? ` @${m.thread_id}` : ""}: ${m.body}  [seq=${m.seq}]`)
        .join("\n");
      await client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: `You are ${agent} on the beamline bus. New mail — act on it, then beamline_ack with YOUR id ${agent}:\n${body}` }] },
      });
      const max = Math.max(...mail.map((m) => m.seq));
      run("ack", ["--agent", agent, "--upto", String(max)]);
      log({ injected: mail.length, upto: max, sessionID });
    } finally {
      inflight.delete(sessionID);
    }
  };

  const timer = setInterval(() => {
    const now = Date.now();
    for (const sid of known) {
      if (now - (lastActivity.get(sid) ?? 0) < QUIET_MS) continue;
      void checkSession(sid).catch((e) => log({ error: String(e?.message ?? e) }));
    }
  }, POLL_MS);
  if (timer.unref) timer.unref();

  return {
    event: async ({ event }) => {
      try {
        const seen = sidOf(event);
        if (seen) {
          known.add(String(seen));
          lastActivity.set(String(seen), Date.now());
        }
        if (event.type === "session.created") {
          const sessionID = sidOf(event);
          if (!sessionID) return;
          const res = JSON.parse(run("link", ["--session", String(sessionID)]) || "{}");
          log({ linked: res.id, sessionID });
          return;
        }
        if (event.type === "session.deleted") {
          const sessionID = sidOf(event);
          if (!sessionID) return;
          run("unlink", ["--session", String(sessionID)]);
          known.delete(String(sessionID));
          log({ unlinked: sessionID });
          return;
        }
        if (event.type !== "session.idle") return;
        const sessionID = sidOf(event);
        if (!sessionID) return;
        await checkSession(sessionID);
      } catch (e) {
        log({ error: String(e?.message ?? e) });
      }
    },
  };
};
