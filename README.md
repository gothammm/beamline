# Beamline

Per-workspace pub/sub mailbox for agent harnesses. No roles. Any session sends, each session receives. The sender dictates.

## Install

Compiled binary, no runtime needed:

```sh
curl -fsSL https://raw.githubusercontent.com/gothammm/beamline/main/install.sh | bash
```

From source with bun:

```sh
bun install -g github:gothammm/beamline
# pin a version:
bun install -g github:gothammm/beamline#v0.3.1
```

From a checkout, for development:

```sh
ln -s <checkout>/src/cli.ts ~/.bun/bin/beamline
```

Then per workspace:

```sh
cd my-project && beamline init
beamline doctor            # all green? done
```

`init` wires up hooks, MCP entries, and the wake plugin inside the workspace. Nothing touches user-global config. Re-runs are idempotent. `doctor` prints a fix hint per failing check; `doctor --fix` writes the project `.mcp.json`.

The bus is workspace-local with no auth. `from_id` is a claim, like a git author. Sender binding becomes mandatory before multi-user or remote use.

## Use

No per-session setup. Launching a harness in an initialized workspace registers it (name + id) on session start:

- **Claude Code:** `SessionStart` runs `beamline link`; `Stop` runs `beamline wake`, which holds the stop and returns new mail.
- **OpenCode:** the plugin links on `session.created` and injects mail as a user turn on `session.idle`. The turn names the agent id (`You are <id> on the beamline bus…`). Idle injects are auto-acked; `beamline_ack` is only for mail fetched with `beamline_wait`/`beamline_poll`.

Then, from any session (MCP tools or CLI):

- `beamline_send { from_id, to_id, body }` / `beamline_broadcast { from_id, body }`
- `beamline_poll { agent_id }` → read; `beamline_ack { agent_id, upto_seq }` → clear
- `beamline_wait { agent_id, timeout_ms }` → ends the turn while waiting for mail; a peer's send resolves it mid-turn
- `beamline_log { from_id, body }` → records without waking anyone; peers read it on explicit poll
- `beamline_list_agents` → who's on the bus

Send when a reply is needed, log when it isn't. A send spends the peer's tokens.

State lives in `<workspace>/.beamline/` (db + session links). The bus follows the workspace: `cd` elsewhere, run `init`, get a fresh bus.

## CLI

`beamline --help` (or `beamline <command> --help`) documents everything. Highlights:

- `--version`, `--debug` (full stacks), `--json` (machine output; default when piped)
- `-C, --workspace <path>` — run any command against another workspace
- `beamline completion bash|zsh|fish` — shell completion
- Terminals get human-readable tables; piped output stays byte-stable JSON (hooks parse it).

## Files

`src/store.ts` (sqlite) · `src/index.ts` (MCP server) · `src/cli.ts` (CLI) · `src/doctor.ts` (checks) · `src/init.ts` (installer) · `plugins/beamline.js` (OC wake plugin) · `install.sh` (binary installer) · `tests/` (`bun test`, 42 green)

## Wake latency

Defaults stay slow to spare CPU: `BEAMLINE_POLL_MS=5000`, `BEAMLINE_QUIET_MS=10000`. The poller shells `beamline poll` per known session each tick, so faster polling spends spawns on `[]` results. Demos use `BEAMLINE_POLL_MS=50 BEAMLINE_QUIET_MS=0`. Sub-second wake without the spawn cost is future work.

## Release

Releases are tags matching package.json: bump the version, commit, `git tag vX.Y.Z`, push the tag. The release action runs `bun test`, compiles a binary per OS, and attaches all three to the GitHub release. The installer fetches from `latest`, so releases need no doc changes. Prove the pipeline with an `rc` tag first, then delete it.
