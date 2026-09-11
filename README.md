# Beamline

Per-workspace pub/sub mailbox for agent harnesses. No roles — any session can send, every session receives. Whoever sends dictates; roles swap freely.

## Install

```sh
# once per machine: `beamline` on PATH
ln -s <checkout>/src/cli.ts ~/.bun/bin/beamline

# once per machine: global hooks + wake plugin
beamline init --global
beamline doctor --global   # all green? done

# per workspace:
cd my-project && beamline init
beamline doctor            # all green? done
```

(`init` merges without clobbering; re-runs are idempotent. `doctor` prints a fix hint per failing check.)

No manual MCP step: `beamline doctor --fix --global` registers the Claude Code MCP (`claude mcp add -s user beamline -- beamline mcp`); workspace `init` never touches user-global config.

Trust: the bus is workspace-local with no auth — `from_id` is asserted, not proven (same trust as the filesystem). Sender binding becomes mandatory if multi-user/remote ever lands.

## Use

Nothing per session. Launch a harness in an initialized workspace and it auto-registers (name + id) on session start:

- **Claude Code:** `SessionStart` → `beamline link`; `Stop` → `beamline wake` blocks the stop and feeds mail back in.
- **OpenCode:** `session.created` → auto-link; `session.idle` → mail injected as a user turn naming your id (`You are <id> on the beamline bus…`).

Then, from any session (MCP tools or CLI):

- `beamline_send { from_id, to_id, body }` / `beamline_broadcast { from_id, body }`
- `beamline_poll { agent_id }` → read; `beamline_ack { agent_id, upto_seq }` → clear
- `beamline_wait { agent_id, timeout_ms }` → end turns with this when expecting mail; a send lands mid-turn
- `beamline_list_agents` → who's on the bus

State lives in `<workspace>/.beamline/` (db + session links). The bus is the workspace: `cd` elsewhere, `init`, get a fresh one.

## CLI

`beamline --help` (or `beamline <command> --help`) documents everything. Highlights:

- `--version`, `--debug` (full stacks), `--json` (machine output; default when piped)
- `-C, --workspace <path>` — run any command against another workspace
- `beamline completion bash|zsh|fish` — shell completion
- Terminals get human-readable tables; pipes keep byte-stable JSON (hooks depend on it)

## Files

`src/store.ts` (sqlite) · `src/index.ts` (MCP server) · `src/cli.ts` (CLI) · `src/doctor.ts` (checks) · `src/init.ts` (installer) · `plugins/beamline.js` (OC wake plugin) · `tests/` (`bun test`, 10 green)
