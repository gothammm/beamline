#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { COMMANDS, parseCommand, type CommandDef } from "./commands.js";
import { c, crash, type Ctx } from "./output.js";
import pkg from "../package.json";

// Static import so the version travels with the source instead of
// depending on a runtime file read next to the entrypoint.
const VERSION = (pkg as { version?: string })?.version ?? "0.0.0";

function printCommandHelp(def: CommandDef) {
  const opts = def.options
    .map((o) => `  --${o.long}${o.required ? " <value> (required)" : o.type === "boolean" ? "" : " <value>"}\n      ${o.description}`)
    .join("\n");
  console.log(`beamline ${def.name} — ${def.description}
Usage: beamline ${def.name}${def.options.length ? " [options]" : ""}${def.name === "wake" ? " [agent-id]" : ""}${def.name === "completion" ? " <bash|zsh|fish>" : ""}
${opts ? `Options:\n${opts}\n` : ""}${def.examples.length ? `Examples:\n${def.examples.map((e) => `  ${e}`).join("\n")}` : ""}`);
}

function printHelp() {
  console.log(`beamline ${VERSION} — per-workspace pub/sub mailbox for agent harnesses.
Usage: beamline <command> [options]

Commands:
${COMMANDS.map((d) => `  ${d.name.padEnd(12)} ${d.description}`).join("\n")}

Global options:
  -h, --help           Show help (or 'beamline <command> --help')
  --version            Show version
  --debug              Full error stacks
  --json               Machine-readable output (default when piped)
  -C, --workspace <p>  Run against another workspace dir

Examples:
  beamline init && beamline doctor
  beamline send --from apollo-1a2b --to astra-368e --body "go"
  beamline wait --agent astra-368e --timeout 30000`);
}

// Closest command by edit distance (empathic unknown-command handling).
function suggest(cmd: string): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const d of COMMANDS.map((c) => c.name)) {
    const m = cmd.length;
    const n = d.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (cmd[i - 1] === d[j - 1] ? 0 : 1));
    if (dp[m][n] < bestD) {
      bestD = dp[m][n];
      best = d;
    }
    if (d.startsWith(cmd)) return d;
  }
  return best;
}

const raw = process.argv.slice(2);

// Global pre-scan: these work in any position (commands never define them).
const has = (flags: string[]) => raw.some((a) => flags.includes(a));
const takeValue = (flags: string[]) => {
  const i = raw.findIndex((a) => flags.includes(a) || flags.some((f) => a.startsWith(`${f}=`)));
  if (i === -1) return null;
  const a = raw[i];
  const eq = flags.map((f) => `${f}=`).find((p) => a.startsWith(p));
  return eq ? a.slice(eq.length) : (raw[i + 1]?.startsWith("-") ? null : raw[i + 1] ?? null);
};
const stripGlobals = raw.filter((a, i) => {
  if (["-h", "--help", "--version", "--debug", "--json"].includes(a)) return false;
  if (["-C", "--workspace"].includes(a) || a.startsWith("--workspace=")) return false;
  const prev = raw[i - 1];
  if ((prev === "-C" || prev === "--workspace") && !a.startsWith("-")) return false;
  return true;
});

const ctx: Ctx = { json: has(["--json"]), debug: has(["--debug"]), command: "" };

const ws = takeValue(["-C", "--workspace"]);
if (raw.some((a) => ["-C", "--workspace"].includes(a) || a.startsWith("--workspace=")) && !ws) {
  console.error(`beamline: --workspace needs a directory. See 'beamline --help'.`);
  process.exit(1);
}
if (ws) {
  try {
    process.chdir(ws);
  } catch {
    console.error(`beamline: cannot chdir to '${ws}'. Fix: pass an existing directory. See 'beamline --help'.`);
    process.exit(1);
  }
}

if (has(["--version"])) {
  console.log(VERSION);
  process.exit(0);
}

const [cmd, ...rest] = stripGlobals;
if (!cmd || has(["-h", "--help"])) {
  if (cmd) {
    const def = COMMANDS.find((d) => d.name === cmd);
    if (!def) {
      const s = suggest(cmd);
      console.error(`beamline: unknown command '${cmd}'.${s ? ` Did you mean '${s}'?` : ""} See 'beamline --help'.`);
      process.exit(1);
    }
    printCommandHelp(def);
  } else printHelp();
  process.exit(0);
}

const def = COMMANDS.find((d) => d.name === cmd);
if (!def) {
  const s = suggest(cmd);
  console.error(`beamline: unknown command '${cmd}'.${s ? ` Did you mean '${s}'?` : ""} See 'beamline --help'.`);
  process.exit(1);
}

ctx.command = cmd;
const { values, positionals } = parseCommand(def, rest, ctx);
try {
  await def.run(values, positionals, ctx);
} catch (e) {
  crash(ctx, e);
}
