import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundledPlugin, runDoctor, scopePaths } from "./doctor.js";

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

// Install the OC wake plugin to the global plugin dir. Returns true if written.
function installOcPlugin(): boolean {
  const src = bundledPlugin();
  const dst = join(homedir(), ".config", "opencode", "plugins", "beamline.js");
  if (existsSync(dst) && readFileSync(dst, "utf8") === readFileSync(src, "utf8")) return false;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
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
  if (global && installOcPlugin()) done.push("opencode plugin installed");

  console.log(done.length ? "--- wrote ---\n" + done.map((d) => `  + ${d}`).join("\n") : "--- wrote ---\n  (nothing — already set up)");
  if (!global) {
    console.log("note: the OpenCode wake plugin installs once per machine — `beamline init --global`");
  } else {
    console.log("note: register the MCP once per machine — `claude mcp add -s user beamline -- beamline mcp`");
  }
  console.log("--- after ---");
  return runDoctor(global);
}
