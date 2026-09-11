import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundledPluginText, ensureClaudeMcp, runDoctor, scopePaths } from "./doctor.js";

const LINK_CMD = "beamline link";
const WAKE_CMD = "beamline wake --hook claude";
const UNLINK_CMD = "beamline unlink";

// Merge hook entries into a CC settings file without clobbering user content.
// Returns names of entries added.
export function mergeCcHooks(path: string): string[] {
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  cur.hooks ??= {};
  const added: string[] = [];
  const ensure = (event: string, command: string) => {
    cur.hooks[event] ??= [];
    const blob = JSON.stringify(cur.hooks[event]);
    if (!blob.includes(command.split(" ")[0] + " " + command.split(" ")[1])) {
      cur.hooks[event].push({ hooks: [{ type: "command", command }] });
      added.push(`${event}→${command}`);
    }
  };
  ensure("SessionStart", LINK_CMD);
  ensure("Stop", WAKE_CMD);
  ensure("SessionEnd", UNLINK_CMD);
  if (added.length) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
  }
  return added;
}

// Merge mcp.beamline into an opencode.json without clobbering. Returns true if written.
export function mergeOcMcp(path: string): boolean {
  const cur = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const have = Array.isArray(cur.mcp?.beamline?.command) && cur.mcp.beamline.command.join(" ").includes("beamline");
  if (have) return false;
  cur.mcp ??= {};
  cur.mcp.beamline = { type: "local", command: ["beamline", "mcp"], enabled: true };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
  return true;
}

// Write the bundled OC wake plugin to a plugin dir. Returns true if written.
export function installOcPlugin(dst: string): boolean {
  const text = bundledPluginText();
  if (existsSync(dst) && readFileSync(dst, "utf8") === text) return false;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, text);
  return true;
}

// Merge the beamline server into a Claude Code .mcp.json without clobbering.
// Returns true if written.
export function mergeMcpJson(path: string): boolean {
  const cur = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as {
    mcpServers?: Record<string, unknown>;
  };
  if (cur.mcpServers?.beamline) return false;
  cur.mcpServers ??= {};
  cur.mcpServers.beamline = { command: "beamline", args: ["mcp"] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cur, null, 2) + "\n");
  return true;
}

export async function runInit(global: boolean): Promise<number> {
  const p = scopePaths(global);
  console.log(`beamline init (${p.label})`);
  console.log("--- before ---");
  await runDoctor(global);

  const done: string[] = [];
  if (!global) {
    mkdirSync(join(p.beamDir, "sessions"), { recursive: true });
    done.push("created .beamline/sessions");
  }
  for (const a of mergeCcHooks(p.ccSettings)) done.push(`hook added: ${a} (${p.ccSettings})`);
  if (mergeOcMcp(p.ocConfig)) done.push(`mcp.beamline added (${p.ocConfig})`);
  // Project plugin dir: OpenCode auto-loads .opencode/plugins/, so workspace
  // init alone wires up wake. Global scope keeps the machine-wide copy.
  const pluginDst = global
    ? join(homedir(), ".config", "opencode", "plugins", "beamline.js")
    : join(process.cwd(), ".opencode", "plugins", "beamline.js");
  if (installOcPlugin(pluginDst)) done.push(`opencode plugin installed (${pluginDst})`);
  if (!global && mergeMcpJson(join(process.cwd(), ".mcp.json"))) {
    done.push("mcp.beamline added (.mcp.json)");
  }
  // Machine scope only: workspace init never mutates user-global config.
  if (global) {
    const r = ensureClaudeMcp();
    done.push(r.ok ? r.detail : `claude MCP skipped (${r.detail})`);
  }

  console.log(done.length ? "--- wrote ---\n" + done.map((d) => `  + ${d}`).join("\n") : "--- wrote ---\n  (nothing — already set up)");
  console.log("--- after ---");
  return runDoctor(global);
}
