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
//   Delivery has two modes: free sessions get a waking turn; sessions that
//   recently timed out a turn are busy, so ticks append context without one
//   (noReply — measured 9ms vs 30s hangs; read on the next step, in order).
//   session.idle, or the wake-retry expiry (WAKE_RETRY_MS, default 300000),
//   flips back to wake mode. A prompt is delivered only when its ack is
//   confirmed; an acked prompt is never re-prompted — later ticks retry the
//   free ack call, never the paid turn. A timed-out batch is trusted to
//   have landed late, so fresh mail carries fresh seqs only (no double-pay).
// - first load reconciles: sessions born while this copy was absent join the
//   known set silently (no prompt — never interrupt a working session).
//   Reconcile never links by itself: history holds dead sessions, and linking
//   each would mass-register orphan agents. A live-but-unlinked session links
//   lazily on its next event, then delivers in the same tick.
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
  // Live env (not the startup snapshot): in-process overrides such as
  // BEAMLINE_* set by the harness must reach CLI children.
  try {
    const proc = Bun.spawnSync(args, { cwd, env: { ...process.env } });
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

  // Session-id gate: opencode session ids look like ses_<hash>. Bare
  // properties.id from unrelated events (provider names like "openai",
  // command names like "command") must never become sessions — the lazy
  // path would register a real agent for each, with the live server pid,
  // so nothing could ever reap them. Link files (hook-created, any
  // harness) always pass: they are proof of a real session.
  const SES_RE = /^ses_[A-Za-z0-9]+$/;
  const sessionLike = (sid) => SES_RE.test(String(sid)) || existsSync(join(directory, ".beamline", "sessions", String(sid)));

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
  const WAKE_RETRY_MS = Math.max(1000, num(process.env.BEAMLINE_WAKE_RETRY_MS, 300000));
  const LOCK_MS = Math.max(60000, PROMPT_MS + 30000);

  const currentAgent = async (sessionID) => {
    try {
      const get = client?.session?.get;
      if (typeof get !== "function") return undefined;
      const res = await get({ path: { id: String(sessionID) } });
      const agent = res?.data?.agent ?? res?.agent ?? res?.data?.mode ?? res?.mode;
      return typeof agent === "string" && agent ? agent : undefined;
    } catch {
      return undefined;
    }
  };

  const prompt = (sessionID, text, noReply, agent) => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`prompt timeout after ${PROMPT_MS}ms`)), PROMPT_MS);
      if (timer.unref) timer.unref();
    });
    return Promise.race([
      client.session.prompt({
        path: { id: sessionID },
        body: { ...(agent ? { agent } : {}), noReply: noReply === true, parts: [{ type: "text", text }] },
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
  };

  // ponytail: mkdir-atomic lockdir single-flights delivery across plugin
  // copies; stale break on dead owner pid or age — ceiling is a stuck live
  // owner blocking one session up to LOCK_MS before the breaker takes over.
  const lockDir = (tag, sid) => join(directory, ".beamline", `${tag}-${String(sid)}.lock`);
  const ownerDead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (e) {
      return e?.code === "ESRCH";
    }
  };
  const takeLock = (sid, tag = "inject") => {
    try {
      mkdirSync(join(directory, ".beamline"), { recursive: true });
      mkdirSync(lockDir(tag, sid));
    } catch {
      try {
        const [pidRaw, atRaw] = readFileSync(join(lockDir(tag, sid), "meta"), "utf8").split(" ");
        if (!ownerDead(Number(pidRaw)) && Date.now() - Number(atRaw) < LOCK_MS) return false;
        rmSync(lockDir(tag, sid), { recursive: true, force: true });
        mkdirSync(lockDir(tag, sid));
      } catch {
        return false;
      }
    }
    try {
      writeFileSync(join(lockDir(tag, sid), "meta"), `${process.pid} ${Date.now()}`);
    } catch {}
    return true;
  };
  const dropLock = (sid, tag = "inject") => {
    try {
      rmSync(lockDir(tag, sid), { recursive: true, force: true });
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

  // Link a session to its agent, idempotent. Single-flighted across plugin
  // copies with its own lock so two copies racing the same new session
  // register exactly one agent. Returns {id, linked} or null when the CLI
  // is unreachable (caller degrades to a no-op, retried next tick/event).
  // Agents are ONLY created here, and only for sessions that demonstrably
  // emit events (created/idle/...) — never for entries that merely exist in
  // session history. That keeps dead history from mass-registering orphans.
  // Non-session ids (provider/command names from unrelated events) are
  // refused outright — see sessionLike.
  const ensureLinked = (sessionID) => {
    const sid = String(sessionID);
    if (!sessionLike(sid)) return null;
    const link = join(directory, ".beamline", "sessions", sid);
    if (existsSync(link)) {
      const id = agentOf(sid);
      if (id) return { id, linked: "existing" };
    }
    if (!takeLock(sid, "link")) return null;
    try {
      if (existsSync(link)) {
        const id = agentOf(sid);
        if (id) return { id, linked: "existing" };
      }
      const out = JSON.parse(run("link", ["--session", sid]) || "{}");
      return out?.id ? { id: out.id, linked: out.linked ?? "new" } : null;
    } catch {
      return null;
    } finally {
      dropLock(sid, "link");
    }
  };

  // Highest seq ever ATTEMPTED per session (prompt called, outcome
  // unknown). A prompt timeout can't cancel the server-side prompt — it
  // usually still lands — so retrying the same batch next tick injects a
  // visible duplicate. While nothing newer arrived, skip re-prompting;
  // when fresh mail arrives only the fresh seqs go out (the timed-out
  // batch is trusted to have landed late — no double-pay).
  // Persisted to .beamline/attempted.json: a restart must not re-inject
  // one batch. Fast failures (≈ rejected, never delivered) stay retryable.
  const attempted = new Map();
  const attemptedFile = () => join(directory, ".beamline", "attempted.json");
  const saveAttempted = () => {
    try {
      mkdirSync(join(directory, ".beamline"), { recursive: true });
      writeFileSync(attemptedFile(), JSON.stringify(Object.fromEntries(attempted)));
    } catch {}
  };
  const markAttempted = (sessionID, max) => {
    attempted.set(sessionID, max);
    saveAttempted();
  };
  try {
    const raw = readFileSync(attemptedFile(), "utf8");
    for (const [k, v] of Object.entries(JSON.parse(raw))) attempted.set(k, v);
  } catch {}
  // Prompt landed but ack failed: safe to retry the ack (free CLI call),
  // never the prompt (paid duplicate turn). Retried at the top of every
  // checkSession; fresh mail never waits on a dead ack.
  const ackPending = new Map();

  // Append mode per session: expiry timestamp, absent = wake mode. A
  // session that timed out a reply-prompt is busy — another reply would
  // hang another 30s, so ticks append context without a turn instead
  // (measured 9ms vs 30s timeouts; the session reads it on its next step,
  // in order, no duplicate). session.idle, or the wake-retry expiry,
  // proves the session can take a turn again and flips back to wake mode.
  const appendUntil = new Map();

  // Confirmed ack: a prompt counts as delivered once attempted, but the
  // cursor must still advance — the ack is retried free (never a second
  // prompt). Ack is max()-idempotent, so retrying it is always safe.
  const ackUpTo = (agent, max) => {
    for (let i = 0; i < 3; i++) {
      try {
        if (JSON.parse(run("ack", ["--agent", agent, "--upto", String(max)]) || "{}").ok === true) return true;
      } catch {}
    }
    return false;
  };

  const checkSession = async (sessionID, via) => {
    if (inflight.has(sessionID)) return;
    if (!sessionLike(sessionID)) return;
    inflight.add(sessionID);
    let locked = false;
    try {
      if (!takeLock(sessionID)) return;
      locked = true;
      let agent = agentOf(sessionID);
      if (!agent) {
        // Lazy link: the session is demonstrably live (it's emitting events)
        // but missed created — bind it silently, then deliver in this tick.
        const bound = ensureLinked(sessionID);
        if (!bound) return;
        agent = bound.id;
        log({ linked: agent, sessionID, via: `lazy-${via}` });
      }
      // Pending ack from a landed prompt: retry it free before polling —
      // never re-prompt for it.
      if (ackPending.has(sessionID)) {
        if (ackUpTo(agent, ackPending.get(sessionID))) ackPending.delete(sessionID);
        else {
          log({ error: "ack retry failed", sessionID, upto: ackPending.get(sessionID), via });
          return;
        }
      }
      const mail = JSON.parse(run("poll", ["--agent", agent]) || "[]");
      if (!mail.length) return;
      const fresh = mail.filter((m) => m.seq > (attempted.get(sessionID) ?? -1));
      if (!fresh.length) return; // attempted already, nothing new — no duplicate
      // Cap the batch over FRESH seqs only: already-attempted mail is
      // trusted to have landed late, never re-paid. Acking through the
      // last shown fresh seq implicitly acks any skipped range.
      const batch = fresh.slice(0, 20);
      const max = Math.max(...batch.map((m) => m.seq));
      // Delivery mode (see appendUntil): busy sessions get a context append,
      // free sessions a waking turn.
      const now = Date.now();
      if ((appendUntil.get(sessionID) ?? 0) <= now) appendUntil.delete(sessionID);
      const useNoReply = appendUntil.has(sessionID);
      // Auto-inject path auto-acks on success — prompt must NOT ask for manual
      // ack (manual ack is only for mail fetched via beamline_wait/poll).
      const mode = await currentAgent(sessionID);
      try {
        await prompt(
          sessionID,
          `You are ${agent} on the beamline bus. New mail (auto-acked through seq ${max} — do NOT call beamline_ack for this batch; use beamline_ack only for mail you fetch yourself via beamline_wait):\n${batch.map(mailLine).join("\n")}`,
          useNoReply,
          mode,
        );
      } catch (e) {
        // Timeout ≈ server accepted the prompt and it may still land:
        // record the attempt so later ticks don't re-inject a duplicate,
        // and switch to append mode so the next attempt can't hang again.
        // Fast failures (≈ rejected, never delivered) stay retryable.
        if (String(e?.message ?? e).includes("prompt timeout")) {
          markAttempted(sessionID, max);
          appendUntil.set(sessionID, Date.now() + WAKE_RETRY_MS);
        }
        log({ error: String(e?.message ?? e), sessionID, upto: max, via });
        return; // mail retained
      }
      if (!ackUpTo(agent, max)) {
        // Landed turn, unmoved cursor: mark it so no later tick re-pays
        // the prompt; the ack itself is retried free on the next tick.
        markAttempted(sessionID, max);
        ackPending.set(sessionID, max);
        log({ error: "ack failed", sessionID, upto: max, via });
        return;
      }
      markAttempted(sessionID, max);
      log({ injected: batch.length, upto: max, sessionID, via });
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

  // Silent reconcile: sessions born while this copy was absent (missed
  // created) join `known` so live ones link lazily on their next event.
  // Reconcile NEVER links by itself: session history includes long-dead
  // sessions, and linking each would mass-register orphan agents no wake
  // path can deliver to. Scoped to this project only — never pull another
  // workspace's sessions into this bus. Runs in the background AFTER hooks
  // return, so a slow/hanging session list or CLI can never stall plugin
  // load (opencode awaits plugin init — blocking here is a silent no-launch).
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
        if (seen && sessionLike(String(seen))) known.add(String(seen));
        if (event.type === "session.created") {
          const sessionID = sidOf(event);
          if (!sessionID) return;
          const res = ensureLinked(sessionID);
          log({ linked: res?.id, sessionID });
          // Identity in-band, announced once: MCP can't resolve the caller
          // server-side, so the session must be told its id or it registers
          // a duplicate that no wake path polls as.
          if (res?.id && res.linked === "new") {
            const mode = await currentAgent(sessionID);
            await prompt(
              String(sessionID),
              `You are ${res.id} on the beamline bus (session ${sessionID}). Send, poll, wait, and ack with this id — reuse it, never beamline_register again. Peers reach you at this id.`,
              false,
              mode,
            );
          }
          return;
        }
        if (event.type === "session.deleted") {
          const sessionID = sidOf(event);
          if (!sessionID) return;
          run("unlink", ["--session", String(sessionID)]);
          known.delete(String(sessionID));
          attempted.delete(String(sessionID));
          ackPending.delete(String(sessionID));
          appendUntil.delete(String(sessionID));
          saveAttempted();
          dropLock(String(sessionID));
          dropLock(String(sessionID), "link");
          log({ unlinked: sessionID });
          return;
        }
        if (event.type !== "session.idle") return;
        const sessionID = sidOf(event);
        if (!sessionID) return;
        // Idle proves the session can take a turn: leave append mode first
        // so this delivery wakes normally.
        appendUntil.delete(String(sessionID));
        await checkSession(sessionID, "idle");
      } catch (e) {
        log({ error: String(e?.message ?? e) });
      }
    },
  };
};
