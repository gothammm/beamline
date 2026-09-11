# Beamline

Per-workspace pub/sub mailbox for agent harnesses. No roles. Any session sends, each session receives. The sender dictates.

## Install

You install the compiled binary (no runtime needed):

```sh
curl -fsSL https://raw.githubusercontent.com/gothammm/beamline/main/install.sh | bash
```

Without bun you stop there. With bun you can install from source instead:

```sh
bun install -g github:gothammm/beamline
# pin a version:
bun install -g github:gothammm/beamline#v0.3.0
```

You develop from a checkout instead:

```sh
ln -s <checkout>/src/cli.ts ~/.bun/bin/beamline
```

Then once per machine plus once per workspace:

```sh
# once per machine: global hooks + wake plugin
beamline init --global
beamline doctor --global   # all green? done

# per workspace:
cd my-project && beamline init
beamline doctor            # all green? done
```

(`init` merges without clobbering; re-runs are idempotent. `doctor` prints a fix hint per failing check.)

Register the Claude Code MCP with `beamline doctor --fix --global`. Workspace `init` leaves your user-global config alone.

The bus is workspace-local with no auth. Treat `from_id` as a claim, like a git author. You add sender binding before multi-user or remote use.

## Use

You do nothing per session. Launch a harness in an initialized workspace and the start hook registers it (name + id):

- **Claude Code:** on `SessionStart` you run `beamline link`; on `Stop`, `beamline wake` holds the stop and returns new mail.
- **OpenCode:** the plugin links on `session.created` and injects mail as a user turn on `session.idle`. The turn names your id (`You are <id> on the beamline bus…`). The plugin acks idle injects for you. You call `beamline_ack` only for mail you fetch with `beamline_wait`/`beamline_poll`.

Then, from any session (MCP tools or CLI):

- `beamline_send { from_id, to_id, body }` / `beamline_broadcast { from_id, body }`
- `beamline_poll { agent_id }` → read; `beamline_ack { agent_id, upto_seq }` → clear
- `beamline_wait { agent_id, timeout_ms }` → end your turn with this while you wait for mail; a peer's send resolves it mid-turn
- `beamline_log { from_id, body }` → record without waking anyone; peers read it on explicit poll
- `beamline_list_agents` → who's on the bus

You send when you need a reply. You log when you don't. A send spends your peer's tokens.

You store state in `<workspace>/.beamline/` (db + session links). The bus follows the workspace: `cd` elsewhere, run `init`, you get a fresh bus.

## CLI

You find everything in `beamline --help` (or `beamline <command> --help`). Highlights:

- `--version`, `--debug` (full stacks), `--json` (machine output; default when piped)
- `-C, --workspace <path>` — run any command against another workspace
- `beamline completion bash|zsh|fish` — shell completion
- You see human-readable tables in a terminal. Piped output stays byte-stable JSON (hooks parse it).

## Files

`src/store.ts` (sqlite) · `src/index.ts` (MCP server) · `src/cli.ts` (CLI) · `src/doctor.ts` (checks) · `src/init.ts` (installer) · `plugins/beamline.js` (OC wake plugin) · `tests/` (`bun test`, 34 green)

## Wake latency

Defaults stay slow to spare your CPU: `BEAMLINE_POLL_MS=5000`, `BEAMLINE_QUIET_MS=10000`. The poller shells `beamline poll` per known session each tick, so faster polling spends spawns on `[]` results. For demos you set `BEAMLINE_POLL_MS=50 BEAMLINE_QUIET_MS=0`. We have not built sub-second wake without the spawn cost.

## Release

You cut a release with a tag that matches package.json: bump the version, commit, `git tag vX.Y.Z`, push the tag. The test action runs `bun test` on the tag.
