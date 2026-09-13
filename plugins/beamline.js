// Beamline wake plugin for OpenCode. Installed per workspace by `beamline init`
// → .opencode/plugins/beamline.js (and machine-wide by `beamline init --global`
// → ~/.config/opencode/plugins/beamline.js; both copies load, so delivery is
// single-flighted, never double).
// - session.created: auto-register this session (name+id), link it, and tell
//   it its id — but only when the binding is new (re-fires skip the announce).
//   In-band identity: MCP can't resolve the caller, so without this the
//   session registers a duplicate no wake path polls as.
// - session.deleted: unlink + remove the agent from the bus.
// - every tick + every session.idle: poll beamline for this session's agent
//   and inject mail as a prompt. Instant delivery by design — no quiet gate.
//   A prompt timeout (PROMPT_MS, default 30000) keeps one hang from stalling
//   a session forever; failed injects stay unacked for the next tick.
// - first load reconciles: sessions born while this copy was absent get linked
//   silently (no prompt — never interrupt a working session).
// Identity resolves via .beamline/sessions/<session-id>; $BEAMLINE_AGENT overrides.
// Each tick shells `beamline poll` per known session (POLL_MS, default 5000,
// floor 250) — spawn cost ~1 bun/session/tick mostly returning []. For demos
// set BEAMLINE_POLL_MS=50. Sub-second latency without spawn cost (single poll,
// in-process read, backoff) is deferred — see store.ts wait.
// Auto-inject path auto-acks after successful prompt(); prompt text says so.
// Manual beamline_ack is only for mail fetched via beamline_wait/poll.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sh = (args, cwd) => {
  // Never throws: a missing CLI (GUI PATH without ~/.local/bin) or empty
  // output degrades to "" and every caller treats "" as no-result.
  try {
    const proc = Bun.spawnSync(args, { cwd });
    return new TextDecoder().decode(proc.stdout);
  } catch {
    return "";
  }
};

export const BeamlinePlugin = async ({ client, directory, project }) => {
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

  // ponytail: in-process guard only; cross-copy single-flight is the lockdir
  // below (global+project copies, or two OC servers, share one workspace bus).
  const inflight = new Set();

  const known = new Set();
  const num = (v, dflt) => {
    const n = Number(v);
    return v !== undefined && v !== "" && !Number.isNaN(n) ? n : dflt;
  };
  const POLL_MS = Math.max(250, num(process.env.BEAMLINE_POLL_MS, 5000));
  const PROMPT_MS = Math.max(50, num(process.env.BEAMLINE_PROMPT_MS, 30000));
  const LOCK_MS = 60000;

  const prompt = (sessionID, text) => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`prompt timeout after ${PROMPT_MS}ms`)), PROMPT_MS);
      if (timer.unref) timer.unref();
    });
    return Promise.race([
      client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
  };

  // ponytail: mkdir-atomic lockdir single-flights delivery across plugin
  // copies; stale break on dead owner pid or age — ceiling is a stuck live
  // owner blocking one session up to LOCK_MS before the breaker takes over.
  const lockDir = (sid) => join(directory, ".beamline", `inject-${String(sid)}.lock`);
  const ownerDead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e?.code === "ESRCH";
    }
  };
  const takeLock = (sid) => {
    try {
      mkdirSync(join(directory, ".beamline"), { recursive: true });
      mkdirSync(lockDir(sid));
    } catch {
      try {
        const [pidRaw, atRaw] = readFileSync(join(lockDir(sid), "meta"), "utf8").split(" ");
        if (!ownerDead(Number(pidRaw)) && Date.now() - Number(atRaw) < LOCK_MS) return false;
        rmSync(lockDir(sid), { recursive: true, force: true });
        mkdirSync(lockDir(sid));
      } catch {
        return false;
      }
    }
    try {
      writeFileSync(join(lockDir(sid), "meta"), `${process.pid} ${Date.now()}`);
    } catch {}
    return true;
  };
  const dropLock = (sid) => {
    try {
      rmSync(lockDir(sid), { recursive: true, force: true });
    } catch {}
  };

  const agentOf = (sessionID) => {
    if (process.env.BEAMLINE_AGENT) return process.env.BEAMLINE_AGENT;
    // Link files are JSON {id, pid, updated} with bare-id read compat.
    const link = join(directory, ".beamline", "sessions", String(sessionID));
    if (!existsSync(link)) return "";
    const raw = readFileSync(link, "utf8").trim();
    try {
      return raw.startsWith("{") ? JSON.parse(raw).id || "" : raw;
    } catch {
      return raw;
    }
  };

  const mailLine = (m) => `📨 from ${m.from_id}${m.thread_id ? ` @${m.thread_id}` : ""}: ${m.body}  [seq=${m.seq}]`;

  const checkSession = async (sessionID, via) => {
    if (inflight.has(sessionID)) return;
    inflight.add(sessionID);
    let locked = false;
    try {
      if (!takeLock(sessionID)) return;
      locked = true;
      const agent = agentOf(sessionID);
      if (!agent) return;
      const mail = JSON.parse(run("poll", ["--agent", agent]) || "[]");
      if (!mail.length) return;
      const max = Math.max(...mail.map((m) => m.seq));
      // Auto-inject path auto-acks on success — prompt must NOT ask for manual
      // ack (manual ack is only for mail fetched via beamline_wait/poll).
      await prompt(
        sessionID,
        `You are ${agent} on the beamline bus. New mail (auto-acked through seq ${max} — do NOT call beamline_ack for this batch; use beamline_ack only for mail you fetch yourself via beamline_wait):\n${mail.slice(0, 20).map(mailLine).join("\n")}`,
      );
      run("ack", ["--agent", agent, "--upto", String(max)]);
      log({ injected: mail.length, upto: max, sessionID, via });
    } finally {
      if (locked) dropLock(sessionID);
      inflight.delete(sessionID);
    }
  };

  const timer = setInterval(() => {
    // ponytail: readdir rescan heals known after server restarts (memory-only
    // set empties, parked sessions emit no events); ceiling is one dir listing
    // per tick — track harness lifecycle events instead if that ever matters.
    try {
      for (const f of readdirSync(join(directory, ".beamline", "sessions"))) known.add(f);
    } catch {}
    for (const sid of known) {
      void checkSession(sid, "poll").catch((e) => log({ error: String(e?.message ?? e) }));
    }
  }, POLL_MS);
  if (timer.unref) timer.unref();

  // Silent reconcile: link sessions born while this copy was absent (missed
  // created). Scoped to this project only — never pull another workspace's
  // sessions into this bus. Runs in the background AFTER hooks return, so a
  // slow/hanging session list or CLI can never stall plugin load (opencode
  // awaits plugin init — blocking here is a silent no-launch).
  const reconcile = async () => {
    try {
      const res = await client.session?.list?.();
      const list = Array.isArray(res) ? res : (res?.data ?? []);
      for (const s of list) {
        const sid = s?.id ? String(s.id) : "";
        if (!sid) continue;
        if (project?.id && s?.projectID && s.projectID !== project.id) continue;
        if (s?.directory && s.directory !== directory) continue;
        known.add(sid);
        const link = join(directory, ".beamline", "sessions", sid);
        if (existsSync(link)) continue;
        const out = JSON.parse(run("link", ["--session", sid]) || "{}");
        if (out?.id) log({ linked: out.id, sessionID: sid, via: "reconcile" });
      }
    } catch (e) {
      log({ error: String(e?.message ?? e) });
    }
  };
  void reconcile();

  return {
    event: async ({ event }) => {
      try {
        const seen = sidOf(event);
        if (seen) known.add(String(seen));
        if (event.type === "session.created") {
          const sessionID = sidOf(event);
          if (!sessionID) return;
          const res = JSON.parse(run("link", ["--session", String(sessionID)]) || "{}");
          log({ linked: res.id, sessionID });
          // Identity in-band, announced once: MCP can't resolve the caller
          // server-side, so the session must be told its id or it registers
          // a duplicate that no wake path polls as.
          if (res.id && res.linked === "new") {
            await prompt(
              String(sessionID),
              `You are ${res.id} on the beamline bus (session ${sessionID}). Send, poll, wait, and ack with this id — reuse it, never beamline_register again. Peers reach you at this id.`,
            );
          }
          return;
        }
        if (event.type === "session.deleted") {
          const sessionID = sidOf(event);
          if (!sessionID) return;
          run("unlink", ["--session", String(sessionID)]);
          known.delete(String(sessionID));
          dropLock(String(sessionID));
          log({ unlinked: sessionID });
          return;
        }
        if (event.type !== "session.idle") return;
        const sessionID = sidOf(event);
        if (!sessionID) return;
        await checkSession(sessionID, "idle");
      } catch (e) {
        log({ error: String(e?.message ?? e) });
      }
    },
  };
};
