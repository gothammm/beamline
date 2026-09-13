import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openStore, type Agent, type Store } from "./store.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: one file, no test doubles — every check hits the real thing
// (real db, real spawned server). Slower (~1-2s), never lies.
export function scopePaths(global: boolean) {
  const ws = process.cwd();
  return {
    label: global ? "machine" : ws,
    beamDir: global ? "" : join(ws, ".beamline"),
    ccSettings: global ? join(homedir(), ".claude", "settings.json") : join(ws, ".claude", "settings.json"),
    ocConfig: global
      ? join(homedir(), ".config", "opencode", "opencode.json")
      : join(ws, "opencode.json"),
    // Workspace scope checks the project plugin dir (OpenCode auto-loads
    // .opencode/plugins/). Global scope keeps the machine-wide copy.
    ocPlugin: global
      ? join(homedir(), ".config", "opencode", "plugins", "beamline.js")
      : join(ws, ".opencode", "plugins", "beamline.js"),
    mcpJson: global ? "" : join(ws, ".mcp.json"),
  };
}

// Text import: bun inlines the file at `bun build --compile`, so the
// standalone binary carries the plugin. Dev runs read the same content.
import pluginText from "../plugins/beamline.js" with { type: "text" };

export function bundledPluginText(): string {
  return pluginText;
}

// Session link files: JSON {id, pid, updated} with bare-id read compat
// (pre-v0.3 `link` wrote the raw id string).
export interface Link {
  id: string;
  pid?: number;
  updated?: number;
}

export function readLink(path: string): Link | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (!raw.startsWith("{")) return { id: raw };
    const j = JSON.parse(raw) as Partial<Link>;
    return typeof j.id === "string"
      ? { id: j.id, pid: typeof j.pid === "number" ? j.pid : undefined }
      : null;
  } catch {
    return null;
  }
}

export type PidState = "dead" | "alive" | "unknown";

// kill(pid, 0) probes liveness: ESRCH = certain-dead, EPERM/other = unknown.
// Unknown never reaps (containers, PID namespaces, foreign users, Windows).
export function pidState(pid: number): PidState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "ESRCH" ? "dead" : "unknown";
  }
}

// Stale = certain-dead pid AND old mtime (both — guards pid reuse).
// Legacy links (no pid) and unprobeable pids never auto-reap.
export const STALE_MS = 60_000;
export function linkStale(path: string, now = Date.now()): { link: Link; stale: boolean; reason: string } | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const link = readLink(path);
  if (!link) return null;
  if (link.pid === undefined) return { link, stale: false, reason: "legacy link (no pid) — warn only" };
  const ps = pidState(link.pid);
  if (ps === "dead" && now - mtimeMs > STALE_MS) {
    return { link, stale: true, reason: `pid ${link.pid} dead + mtime stale` };
  }
  return { link, stale: false, reason: ps === "unknown" ? `pid ${link.pid} unprobeable — warn only` : `pid ${link.pid} alive` };
}

export type LinkFlag = "live" | "stale" | "legacy" | "none";

export interface AgentRow extends Agent {
  session: string | null;
  link: LinkFlag;
}

// Every session link in a workspace, unreadable files skipped.
export function sessionLinks(beamDir: string): { session: string; link: Link; stale: boolean }[] {
  const out: { session: string; link: Link; stale: boolean }[] = [];
  let files: string[];
  try {
    files = readdirSync(join(beamDir, "sessions"));
  } catch {
    return out;
  }
  for (const f of files) {
    const hit = linkStale(join(beamDir, "sessions", f));
    if (hit) out.push({ session: f, link: hit.link, stale: hit.stale });
  }
  return out;
}

// Agents joined with link state: which session (if any) binds them and
// whether that session is demonstrably alive. lastActive breaks ties
// between duplicate codenames.
export function agentRows(store: Store, beamDir: string): AgentRow[] {
  const byAgent = new Map<string, { session: string; stale: boolean; legacy: boolean }>();
  for (const { session, link, stale } of sessionLinks(beamDir)) {
    if (!byAgent.has(link.id)) {
      byAgent.set(link.id, { session, stale, legacy: link.pid === undefined });
    }
  }
  return store.listAgents().map((a) => {
    const hit = byAgent.get(a.id);
    const link: LinkFlag = !hit ? "none" : hit.stale ? "stale" : hit.legacy ? "legacy" : "live";
    return { ...a, session: hit?.session ?? null, link };
  });
}

// Id-or-name resolution with liveness routing. Exact id always wins
// (back-compat). A codename resolving to exactly one agent routes;
// several → the single live one wins; genuinely ambiguous (or unknown)
// throws an error the caller surfaces verbatim — it names the candidates
// so the sender retries with an exact id instead of guessing.
export function resolveRecipient(store: Store, beamDir: string, ref: string): Agent {
  const found = store.resolveRef(ref);
  if (!found) throw new Error(`unknown recipient "${ref}" — no agent with that id or name`);
  if ("agent" in found) return found.agent; // exact id, or a codename with one match
  const candidates = found.candidates;
  const live = new Set(agentRows(store, beamDir).filter((r) => r.link === "live").map((r) => r.id));
  const liveMatches = candidates.filter((c) => live.has(c.id));
  if (liveMatches.length === 1) return liveMatches[0];
  const rows = agentRows(store, beamDir);
  const detail = candidates
    .map((c) => {
      const r = rows.find((x) => x.id === c.id);
      return `${c.id} (${r?.link ?? "none"}${r?.session ? `, session ${r.session}` : ""}${c.lastActive ? `, last active ${new Date(c.lastActive).toISOString()}` : ", never talked"})`;
    })
    .join("; ");
  throw new Error(`ambiguous recipient "${ref}" — ${candidates.length} matches: ${detail}. Retry with the exact agent id`);
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function mcpSmoke(): Promise<Check> {
  const bin = Bun.which("beamline") ?? "beamline";
  const base = { name: "mcp-server", ok: false, detail: "", fix: "reinstall the CLI so `beamline mcp` runs" };
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn([bin, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const lines: string[] = [];
    let buf = "";
    const reader = (async () => {
      for await (const chunk of proc!.stdout) {
        buf += new TextDecoder().decode(chunk as Uint8Array);
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        lines.push(...parts.filter(Boolean));
      }
    })();
    const send = (o: unknown) => proc!.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "0" } } });
    const deadline = Date.now() + 10000;
    const waitFor = async (id: number) => {
      for (;;) {
        for (const l of lines.splice(0)) {
          try {
            const m = JSON.parse(l);
            if (m.id === id) return m;
          } catch {}
        }
        if (Date.now() > deadline) throw new Error("timeout");
        await sleep(100);
      }
    };
    await waitFor(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const res = await waitFor(2);
    void reader;
    const names = (res.result?.tools ?? []).map((t: { name: string }) => t.name);
    const want = ["beamline_register", "beamline_send", "beamline_broadcast", "beamline_log", "beamline_poll", "beamline_wait", "beamline_ack", "beamline_list_agents", "beamline_unregister"];
    const missing = want.filter((w) => !names.includes(w));
    proc.kill();
    if (missing.length) return { ...base, detail: `missing tools: ${missing.join(",")}`, fix: "`beamline mcp` is stale — reinstall" };
    return { ...base, ok: true, detail: `${want.length} tools via \`${bin} mcp\`` };
  } catch (e) {
    try {
      proc?.kill();
    } catch {}
    return { ...base, detail: `no handshake (${String(e)})` };
  }
}

export async function collectChecks(global: boolean): Promise<Check[]> {
  const p = scopePaths(global);
  const out: Check[] = [];

  out.push(
    Bun.which("beamline")
      ? { name: "cli-on-path", ok: true, detail: Bun.which("beamline")! }
      : { name: "cli-on-path", ok: false, detail: "`beamline` not on PATH", fix: "`bun install -g` from the beamline checkout" },
  );

  if (!global) {
    try {
      mkdirSync(p.beamDir, { recursive: true });
      const probe = join(p.beamDir, ".writable");
      await Bun.write(probe, "x");
      (await import("node:fs")).unlinkSync(probe);
      out.push({ name: "workspace", ok: true, detail: p.beamDir });
    } catch (e) {
      out.push({ name: "workspace", ok: false, detail: String(e), fix: "run from a writable workspace" });
    }
    try {
      const store = openStore(join(p.beamDir, "beamline.db"));
      const n = store.listAgents().length;
      out.push({ name: "store", ok: true, detail: `${join(p.beamDir, "beamline.db")} (${n} agents)` });
    } catch (e) {
      out.push({ name: "store", ok: false, detail: String(e), fix: "`beamline reset --force`" });
    }
  }

  out.push(await mcpSmoke());

  const cc = readJson(p.ccSettings) as { hooks?: Record<string, unknown[]> } | null;
  const ccText = cc ? JSON.stringify(cc.hooks ?? {}) : "";
  const hasLink = ccText.includes("beamline link");
  const hasWake = ccText.includes("beamline wake");
  out.push(
    cc && hasLink && hasWake
      ? { name: "claude-hooks", ok: true, detail: p.ccSettings }
      : {
          name: "claude-hooks",
          ok: false,
          detail: `${p.ccSettings} ${cc ? `missing: ${[!hasLink && "SessionStart→link", !hasWake && "Stop→wake"].filter(Boolean).join(", ")}` : "not found"}`,
          fix: global ? "`beamline init --global`" : "`beamline init`",
        },
  );

  const oc = readJson(p.ocConfig) as { mcp?: Record<string, { command?: unknown }> } | null;
  const ocCmd = oc?.mcp?.beamline?.command;
  const ocOk = Array.isArray(ocCmd) && ocCmd.join(" ").includes("beamline");
  out.push(
    ocOk
      ? { name: "opencode-mcp", ok: true, detail: p.ocConfig }
      : {
          name: "opencode-mcp",
          ok: false,
          detail: `${p.ocConfig} ${oc ? "mcp.beamline missing" : "not found"}`,
          fix: global ? "`beamline init --global`" : "`beamline init`",
        },
  );

  const bundled = bundledPluginText();
  const installed = existsSync(p.ocPlugin) ? readFileSync(p.ocPlugin, "utf8") : null;
  out.push(
    installed && bundled && installed === bundled
      ? { name: "opencode-plugin", ok: true, detail: p.ocPlugin }
      : {
          name: "opencode-plugin",
          ok: false,
          detail: !installed ? `${p.ocPlugin} not installed` : "installed copy differs from bundled (stale)",
          fix: "`beamline init`",
        },
  );

  if (!global) {
    try {
      const store = openStore(join(p.beamDir, "beamline.db"));
      const found = store.listAgents().find((a) => a.name === "Doctor") ?? store.register("Doctor");
      const m = store.send(found.id, found.id, "ok");
      const got = store.poll(found.id, m.seq - 1);
      store.ack(found.id, m.seq);
      // Self-test agent is ephemeral — never leave a Doctor row behind.
      store.unregister(found.id);
      out.push(
        got.length === 1
          ? { name: "bus-selftest", ok: true, detail: `send→poll→ack as ${found.id} (cleaned up)` }
          : { name: "bus-selftest", ok: false, detail: "round-trip mismatch", fix: "`beamline reset --force`" },
      );
      const sessDir = join(p.beamDir, "sessions");
      const files = existsSync(sessDir) ? (await import("node:fs")).readdirSync(sessDir) : [];
      const stale = files.filter((f) => linkStale(join(sessDir, f))?.stale);
      out.push(
        stale.length
          ? { name: "sessions", ok: false, detail: `${stale.length} stale link(s): ${stale.join(", ")}`, fix: "beamline unlink --sweep" }
          : { name: "sessions", ok: true, detail: `${files.length} linked, ${store.listAgents().length} agents` },
      );
      // Stranded mail: unacked non-quiet mail for agents no session links to.
      // Wake can never deliver it — silent inbox until someone rebinds.
      // Presence (not freshness) is the signal: the poller rescans link files
      // after restarts, so any link heals; staleness stays the `sessions`
      // check's reaping concern.
      const live = new Set(
        files.flatMap((f) => {
          const id = readLink(join(sessDir, f))?.id;
          return id ? [id] : [];
        }),
      );
      const stranded = store
        .listAgents()
        .flatMap((a) => {
          const n = store.poll(a.id).length;
          return n && !live.has(a.id) ? [`${n} for ${a.id}`] : [];
        });
      out.push(
        stranded.length
          ? {
              name: "stranded-mail",
              ok: false,
              detail: `${stranded.join(", ")} — no session links to the recipient, wake can never deliver`,
              fix: "beamline link --session <id> --to <agent> to rebind a session to the recipient",
            }
          : { name: "stranded-mail", ok: true, detail: "every recipient has a linked session" },
      );
    } catch (e) {
      out.push({ name: "bus-selftest", ok: false, detail: String(e), fix: "`beamline reset --force`" });
    }
  }
  return out;
}

// Best-effort: register beamline MCP in Claude Code user config. Never throws —
// workspace `init` must not mutate user-global config, so only `doctor --fix`
// and `init --global` call this. Returns human detail for the log line.
export function ensureClaudeMcp(): { ok: boolean; detail: string } {
  if (!Bun.which("claude")) return { ok: false, detail: "`claude` not on PATH — run `claude mcp add -s user beamline -- beamline mcp` by hand" };
  try {
    const proc = Bun.spawnSync(
      ["claude", "mcp", "add", "-s", "user", "beamline", "--", "beamline", "mcp"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode === 0) return { ok: true, detail: "claude mcp add -s user beamline" };
    const err = new TextDecoder().decode(proc.stderr).trim().slice(0, 200);
    return { ok: false, detail: err || `exit ${proc.exitCode}` };
  } catch (e) {
    return { ok: false, detail: String(e) };
  }
}

export async function runDoctor(global: boolean, json = false, fix = false): Promise<number> {
  const p = scopePaths(global);
  let fixLine = "";
  if (fix && global) {
    const r = ensureClaudeMcp();
    fixLine = r.ok ? `  + ${r.detail}` : `  ! ${r.detail}`;
  }
  if (fix && !global) {
    // Workspace scope: project .mcp.json covers Claude Code, no user-global mutation.
    const { mergeMcpJson } = await import("./init.js");
    // stderr: stdout stays byte-stable JSON when piped (hooks depend on it).
    console.error(mergeMcpJson(p.mcpJson) ? `  + mcp.beamline added (${p.mcpJson})` : `  = .mcp.json already set (${p.mcpJson})`);
  }
  const checks = await collectChecks(global);
  if (json) {
    if (fixLine) console.error(fixLine);
    console.log(JSON.stringify(checks));
    return checks.filter((c) => !c.ok).length;
  }
  console.log(`beamline doctor (${p.label})`);
  if (fixLine) console.log(`--- fix ---\n${fixLine}`);
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "[✓]" : "[✗]"} ${c.name} — ${c.detail}${!c.ok && c.fix ? ` (fix: ${c.fix})` : ""}`);
    if (!c.ok) failed++;
  }
  return failed;
}
