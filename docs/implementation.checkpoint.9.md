# Checkpoint 9 — auto-register, tests, both-scope verification (DONE)

## Built
- `plugins/beamline.js` — `session.created` → `beamline register --link <sessionID>` (auto-identity, zero setup); idle path now shells to `beamline` on PATH (`$BEAMLINE_HOME` fallback kept); removed a duplicated guard.
- Identity fix (found live): injected prompt now names the id — `You are <id> on the beamline bus…` — and `register`/`wait` tool descriptions say to reuse the linked id. Before: model self-registered `musespark-7968` and waited on the wrong id while its mail sat at `jade-bd1c`.
- `src/init.ts` — `mergeCcHooks`/`mergeOcMcp` exported for tests.
- `tests/init.test.ts` — merge preserves + idempotent (CC + OC), link idempotent via spawned CLI, doctor fail-matrix (bare ws → exactly `[claude-hooks, opencode-mcp]`; green after merges). **10/10 pass.**
- Repo dogfood updated to the new flow: `.claude/settings.json` (`beamline link`/`beamline wake`), `.mcp.json` (`beamline mcp`), README rewritten (install → use → files).

## Verified live
- Zero-setup workspace `/tmp/bl9` (no init, no env): `link`×2 → send → `wake --hook claude` blocks with mail. CC global path ✅
- OC global path: `opencode run` → `session.created` auto-linked `jade-bd1c` (logged, zero setup) → seeded mail → continued session → `injected:1` → model used the WRONG id (self-registered) → after identity fix, second mail → model `beamline_ack`d as jade, cursor empty ✅
- Stale-plugin detection fired mid-work (edited plugin → doctor ✗ → `init --global` refreshed → ✓).
- `bun test`: 10 pass, 0 fail.

## Known behaviors (not bugs)
- One agent row per session launch (`list_agents` grows; rows are tiny; prune later if it matters).
- Headless `opencode run` stores injected turns without running them; TUI/serve continue. `wait`-discipline covers `run`.
- `claude mcp add` stays manual (broken `claude` binary in this env, unrelated to beamline).

## Skipped (ponytail ledger, cumulative)
Daemon, SSE/HTTP, Redis/NATS, topics, auth, presence, mid-generation interrupt, third-party hook plugins, arg-parser lib, nanoid, npm publish (`bunx` later). `ponytail:` markers in code name each ceiling.
