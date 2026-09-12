import { parseArgs } from "node:util";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Message, type Store } from "./store.js";
import { crash, c, data, debugLog, emitJson, fail, type Ctx } from "./output.js";
import { printCompletion } from "./completion.js";

export interface OptionDef {
  long: string;
  short?: string;
  type?: "string" | "boolean";
  required?: boolean;
  description: string;
}

export interface CommandDef {
  name: string;
  description: string;
  examples: string[];
  options: OptionDef[];
  run: (values: Record<string, string | boolean | undefined>, positionals: string[], ctx: Ctx) => Promise<void> | void;
}

// --- shared mailbox plumbing (unchanged behavior) ---

let _store: Store | null = null;
const beamDir = () => join(process.cwd(), ".beamline");
function useStore(): Store {
  if (!_store) {
    mkdirSync(beamDir(), { recursive: true });
    _store = openStore(join(beamDir(), "beamline.db"));
  }
  return _store;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return Bun.stdin.text();
}

function writeLink(path: string, id: string) {
  mkdirSync(join(beamDir(), "sessions"), { recursive: true });
  writeFileSync(path, JSON.stringify({ id, pid: process.pid, updated: Date.now() }));
}

function sessionIdFrom(text: string): string {
  try {
    const j = JSON.parse(text);
    return j.session_id ?? j.sessionID ?? j.sessionId ?? "";
  } catch {
    return text.match(/"session_?[Ii][Dd]?"\s*:\s*"([^"]+)"/)?.[1] ?? "";
  }
}

async function resolveAgent(explicit: string | undefined, ctx: Ctx): Promise<string> {
  if (explicit) return explicit;
  if (process.env.BEAMLINE_AGENT) return process.env.BEAMLINE_AGENT;
  const key = process.env.BEAMLINE_SESSION || sessionIdFrom(await readStdin());
  debugLog(ctx, "wake key:", key || "(none)");
  if (key) {
    const { readLink } = await import("./doctor.js");
    const link = readLink(join(beamDir(), "sessions", key));
    if (link) return link.id;
  }
  return "";
}

const mailLine = (m: Message) =>
  `📨 from ${m.from_id}${m.thread_id ? ` @${m.thread_id}` : ""}: ${m.body}  [seq=${m.seq}]`;

// Hook formats are byte-frozen machine contracts — never gate or restyle these.
function printHook(rows: Message[], format: string | undefined) {
  if (format && rows.length === 0) process.exit(0);
  if (format === "lines") {
    for (const m of rows) console.log(mailLine(m));
  } else if (format === "claude") {
    emitJson({
      decision: "block",
      reason: "New beamline mail — read it with beamline_poll, act on it, then beamline_ack:\n" +
        rows.slice(0, 20).map(mailLine).join("\n"),
    });
  } else emitJson(rows);
}

function need(values: Record<string, string | boolean | undefined>, names: string[], ctx: Ctx) {
  for (const n of names) {
    if (values[n] === undefined || values[n] === "") {
      fail(ctx, `--${n} is required`, `pass --${n} <value>`);
    }
  }
}

const asStr = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

export const COMMANDS: CommandDef[] = [
  {
    name: "register",
    description: "Join this workspace bus. Prints {id, name} — save the id.",
    examples: ["beamline register --name Apollo"],
    options: [
      { long: "name", description: "Preferred codename (random one if omitted or taken)" },
    ],
    run(values, _pos, ctx) {
      const store = useStore();
      const a = store.register(asStr(values.name));
      data(ctx, a, () => `Registered ${c("green", a.name)} as ${c("bold", a.id)}`);
    },
  },
  {
    name: "link",
    description: "Link a harness session to a beamline agent (SessionStart hook). Idempotent.",
    examples: ["echo '{\"session_id\":\"abc\"}' | beamline link", "beamline link --session abc", "beamline link --session abc --name Apollo"],
    options: [
      { long: "session", description: "Harness session id (or pipe hook JSON on stdin)" },
      { long: "name", description: "Preferred codename (or $BEAMLINE_NAME; random if omitted/taken)" },
    ],
    async run(values, _pos, ctx) {
      const store = useStore();
      const { readLink } = await import("./doctor.js");
      const sid = asStr(values.session) || sessionIdFrom(await readStdin());
      if (!sid) fail(ctx, "no session id", "pipe hook JSON on stdin or pass --session <id>");
      mkdirSync(join(beamDir(), "sessions"), { recursive: true });
      const f = join(beamDir(), "sessions", sid);
      if (existsSync(f)) {
        const a = store.agent(readLink(f)?.id ?? "");
        if (a) {
          writeLink(f, a.id); // refresh pid/mtime on re-link
          data(ctx, { ...a, session: sid, linked: "existing" }, () => `${c("green", a.name)} (${a.id}) already linked to ${sid}`);
          return;
        }
      }
      const a = store.register(asStr(values.name) || process.env.BEAMLINE_NAME || undefined);
      writeLink(f, a.id);
      data(ctx, { ...a, session: sid, linked: "new" }, () => `Linked ${c("green", a.name)} (${c("bold", a.id)}) to ${sid}`);
    },
  },
  {
    name: "unlink",
    description: "Remove a harness session's agent (SessionEnd hook). Idempotent, always exits 0.",
    examples: ["echo '{\"session_id\":\"abc\"}' | beamline unlink", "beamline unlink --session abc", "beamline unlink --agent apollo-1a2b", "beamline unlink --sweep"],
    options: [
      { long: "session", description: "Harness session id (or pipe hook JSON on stdin)" },
      { long: "agent", description: "Agent id to remove (alternative to --session)" },
      { long: "sweep", type: "boolean", description: "Reap all stale session links (dead pid + old mtime)" },
    ],
    async run(values, _pos, ctx) {
      const store = useStore();
      const { linkStale, readLink } = await import("./doctor.js");
      if (values.sweep === true) {
        const dir = join(beamDir(), "sessions");
        const swept: string[] = [];
        if (existsSync(dir)) {
          for (const f of (await import("node:fs")).readdirSync(dir)) {
            const p = join(dir, f);
            const hit = linkStale(p);
            if (!hit?.stale) continue;
            store.unregister(hit.link.id);
            try {
              (await import("node:fs")).unlinkSync(p);
            } catch {}
            swept.push(`${f}→${hit.link.id}`);
          }
        }
        data(ctx, { ok: true, swept }, () => (swept.length ? `Swept ${swept.join(", ")}` : c("gray", "(nothing stale)")));
        return;
      }
      const sid = asStr(values.session) || sessionIdFrom(await readStdin());
      const explicit = asStr(values.agent);
      let id = explicit ?? "";
      let sessionFile = "";
      if (!id && sid) {
        sessionFile = join(beamDir(), "sessions", sid);
        if (existsSync(sessionFile)) id = readLink(sessionFile)?.id ?? "";
      }
      if (!id) process.exit(0);
      const existed = store.unregister(id);
      if (sessionFile && existsSync(sessionFile)) {
        try {
          (await import("node:fs")).unlinkSync(sessionFile);
        } catch {}
      }
      // Also sweep any other stale session files pointing at this agent (killed harnesses).
      if (explicit) {
        try {
          const dir = join(beamDir(), "sessions");
          for (const f of (await import("node:fs")).readdirSync(dir)) {
            const p = join(dir, f);
            try {
              if (readLink(p)?.id === id) (await import("node:fs")).unlinkSync(p);
            } catch {}
          }
        } catch {}
      }
      data(ctx, { ok: true, id, removed: existed }, () => (existed ? `Unlinked ${c("bold", id)}` : c("gray", "(already gone)")));
    },
  },
  {
    name: "wake",
    description: "Poll for this session's mail (Stop/idle hook). Always exits 0.",
    examples: ["beamline wake --hook claude", "beamline wake astra-368e"],
    options: [{ long: "hook", description: "Output format: lines (default) or claude (Stop-blocking JSON)" }],
    async run(values, pos, ctx) {
      const store = useStore();
      const agent = await resolveAgent(pos[0], ctx);
      if (!agent) process.exit(0);
      printHook(store.poll(agent), asStr(values.hook) || "lines");
    },
  },
  {
    name: "send",
    description: "Send a direct message to one agent by id.",
    examples: ['beamline send --from apollo-1a2b --to astra-368e --body "go"'],
    options: [
      { long: "from", required: true, description: "Sender agent id" },
      { long: "to", required: true, description: "Recipient agent id" },
      { long: "body", required: true, description: "Message text" },
      { long: "thread", description: "Optional thread id" },
    ],
    run(values, _pos, ctx) {
      need(values, ["from", "to", "body"], ctx);
      try {
        const m = useStore().send(values.from as string, values.to as string, values.body as string, asStr(values.thread));
        data(ctx, m, () => `Sent to ${c("bold", m.to_id ?? "")} ${c("gray", `[seq=${m.seq}]`)}`);
      } catch (e) {
        crash(ctx, e, "verify ids with 'beamline agents'");
      }
    },
  },
  {
    name: "broadcast",
    description: "Send a message to every agent on this workspace bus.",
    examples: ['beamline broadcast --from apollo-1a2b --body "standup in 5"'],
    options: [
      { long: "from", required: true, description: "Sender agent id" },
      { long: "body", required: true, description: "Message text" },
      { long: "thread", description: "Optional thread id" },
    ],
    run(values, _pos, ctx) {
      need(values, ["from", "body"], ctx);
      try {
        const m = useStore().broadcast(values.from as string, values.body as string, asStr(values.thread));
        data(ctx, m, () => `Broadcast ${c("gray", `[seq=${m.seq}]`)}`);
      } catch (e) {
        crash(ctx, e, "verify the sender id with 'beamline agents'");
      }
    },
  },
  {
    name: "log",
    description: "Record a log line without waking anyone. Peers read it on explicit poll.",
    examples: ['beamline log --from apollo-1a2b --body "deployed"', 'beamline log --from apollo-1a2b --to astra-368e --body "fyi"'],
    options: [
      { long: "from", required: true, description: "Sender agent id" },
      { long: "body", required: true, description: "Log text" },
      { long: "to", description: "One peer's FYI (omit: every agent can read it)" },
      { long: "thread", description: "Optional thread id" },
    ],
    run(values, _pos, ctx) {
      need(values, ["from", "body"], ctx);
      try {
        const m = useStore().log(values.from as string, values.body as string, asStr(values.to), asStr(values.thread));
        data(ctx, m, () => `Logged ${c("gray", `[seq=${m.seq}]`)}`);
      } catch (e) {
        crash(ctx, e, "verify ids with 'beamline agents'");
      }
    },
  },
  {
    name: "poll",
    description: "Fetch messages for an agent after a seq (defaults to its ack cursor).",
    examples: ["beamline poll --agent astra-368e", "beamline poll --agent astra-368e --after 12"],
    options: [
      { long: "agent", required: true, description: "Agent id" },
      { long: "after", description: "Only messages with seq greater than this" },
      { long: "hook", description: "Machine format: lines or claude (byte-frozen)" },
      { long: "include-quiet", type: "boolean", description: "Also return quiet log lines" },
    ],
    run(values, _pos, ctx) {
      need(values, ["agent"], ctx);
      const after = asStr(values.after) ? Number(values.after) : undefined;
      const rows = useStore().poll(values.agent as string, after, values["include-quiet"] === true);
      const hook = asStr(values.hook);
      if (hook) printHook(rows, hook);
      else data(ctx, rows, () => (rows.length ? rows.map(mailLine).join("\n") : c("gray", "(no mail)")));
    },
  },
  {
    name: "wait",
    description: "Block until mail arrives for an agent or the timeout elapses.",
    examples: ["beamline wait --agent astra-368e --timeout 30000"],
    options: [
      { long: "agent", required: true, description: "Agent id" },
      { long: "after", description: "Only messages with seq greater than this" },
      { long: "timeout", description: "Max wait in ms (default 30000)" },
      { long: "include-quiet", type: "boolean", description: "Also resolve on quiet log lines" },
    ],
    async run(values, _pos, ctx) {
      need(values, ["agent"], ctx);
      const after = asStr(values.after) ? Number(values.after) : undefined;
      const rows = await useStore().wait(values.agent as string, after, asStr(values.timeout) ? Number(values.timeout) : 30000, values["include-quiet"] === true);
      data(ctx, rows, () => (rows.length ? rows.map(mailLine).join("\n") : c("gray", "(timed out, no mail)")));
    },
  },
  {
    name: "ack",
    description: "Advance an agent's read cursor past a seq so poll/wait skip old mail.",
    examples: ["beamline ack --agent astra-368e --upto 12"],
    options: [
      { long: "agent", required: true, description: "Agent id" },
      { long: "upto", required: true, description: "Sequence number to ack through" },
    ],
    run(values, _pos, ctx) {
      need(values, ["agent", "upto"], ctx);
      useStore().ack(values.agent as string, Number(values.upto));
      data(ctx, { ok: true }, () => `Acked through seq ${c("bold", String(values.upto))}`);
    },
  },
  {
    name: "agents",
    description: "List all agents registered on this workspace bus.",
    examples: ["beamline agents", "beamline agents --stale"],
    options: [{ long: "stale", type: "boolean", description: "List stale session links instead (dead pid + old mtime)" }],
    async run(values, _pos, ctx) {
      if (values.stale === true) {
        const { linkStale } = await import("./doctor.js");
        const dir = join(beamDir(), "sessions");
        const rows: { session: string; agent: string; reason: string }[] = [];
        if (existsSync(dir)) {
          for (const f of (await import("node:fs")).readdirSync(dir)) {
            const hit = linkStale(join(dir, f));
            if (hit?.stale) rows.push({ session: f, agent: hit.link.id, reason: hit.reason });
          }
        }
        data(ctx, rows, () => (rows.length ? rows.map((r) => `${c("bold", r.session)}→${r.agent}  ${c("gray", r.reason)}`).join("\n") : c("gray", "(nothing stale)")));
        return;
      }
      const list = useStore().listAgents();
      data(ctx, list, () => (list.length ? list.map((a) => `${c("bold", a.id)}  ${a.name}`).join("\n") : c("gray", "(no agents — beamline register)")));
    },
  },
  {
    name: "reset",
    description: "Wipe this workspace's bus: all agents, messages, and session links. Hooks and configs survive — no re-init needed. CLI-only (never over MCP: the bus has no auth).",
    examples: ["beamline reset --force"],
    options: [
      { long: "force", type: "boolean", description: "Required. Without it nothing happens." },
    ],
    async run(values, _pos, ctx) {
      if (values.force !== true) fail(ctx, "refusing to wipe without --force", "pass --force to wipe this workspace's bus");
      const store = useStore();
      const { agents, messages } = store.reset();
      let links = 0;
      const dir = join(beamDir(), "sessions");
      if (existsSync(dir)) {
        for (const f of (await import("node:fs")).readdirSync(dir)) {
          try {
            (await import("node:fs")).unlinkSync(join(dir, f));
            links++;
          } catch {}
        }
      }
      data(ctx, { agents, messages, links }, () => `Reset: ${agents} agents, ${messages} messages, ${links} links wiped`);
    },
  },
  {
    name: "mcp",
    description: "Run the MCP stdio server (used by harness configs, not by hand).",
    examples: [],
    options: [],
    async run() {
      const { runServer } = await import("./index.js");
      await runServer();
    },
  },
  {
    name: "init",
    description: "Initialize beamline for a workspace (or --global for the machine). Verifies after.",
    examples: ["beamline init", "beamline init --global"],
    options: [{ long: "global", type: "boolean", description: "Machine scope instead of workspace" }],
    async run(values) {
      const { runInit } = await import("./init.js");
      process.exit((await runInit(values.global === true)) ? 1 : 0);
    },
  },
  {
    name: "doctor",
    description: "Check the beamline setup and report what is broken, with fixes.",
    examples: ["beamline doctor", "beamline doctor --global", "beamline doctor --fix --global"],
    options: [
      { long: "global", type: "boolean", description: "Machine scope instead of workspace" },
      { long: "json", type: "boolean", description: "Machine-readable report" },
      { long: "fix", type: "boolean", description: "Attempt fixes (global scope: register Claude Code MCP)" },
    ],
    async run(values, _pos, ctx) {
      const { runDoctor } = await import("./doctor.js");
      const asJson = ctx.json || values.json === true;
      process.exit((await runDoctor(values.global === true, asJson, values.fix === true)) ? 1 : 0);
    },
  },
  {
    name: "completion",
    description: "Print a shell completion script (bash, zsh, or fish).",
    examples: ["beamline completion bash > ~/.local/share/bash-completion/completions/beamline"],
    options: [],
    run(_values, pos, ctx) {
      printCompletion(pos[0] ?? "", ctx);
    },
  },
];

export function parseCommand(def: CommandDef, argv: string[], ctx: Ctx) {
  const tokens: Record<string, { type: "string" | "boolean"; short?: string }> = {};
  for (const o of def.options) tokens[o.long] = o.short ? { type: o.type ?? "string", short: o.short } : { type: o.type ?? "string" };
  try {
    const { values, positionals } = parseArgs({ args: argv, options: tokens, strict: true, allowPositionals: true });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (e) {
    fail(ctx, e instanceof Error ? e.message : String(e));
  }
}
