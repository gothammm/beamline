# Checkpoint 8 — `doctor` + `init`, both scopes (DONE)

## Built
- `src/doctor.ts` — `collectChecks(global)` + `runDoctor`; checks: cli-on-path, workspace, store, mcp-smoke (real spawned `beamline mcp` handshake, 7 tools), claude-hooks, opencode-mcp, opencode-plugin (content-hash vs bundled), bus-selftest (reused `Doctor` agent, send→poll→ack), sessions (info). Exit ≠ 0 on failure, fix hints everywhere.
- `src/init.ts` — `runInit(global)`: doctor-pre → merge/write → doctor-post. Merges never clobber (hook dedup by command substring, mcp overwrite only if missing/stale, plugin copy only if different). Local scope: `.beamline/sessions`, `.claude/settings.json`, `opencode.json`. Global scope: `~/.claude/settings.json`, `~/.config/opencode/opencode.json`, plugin copy.

## Verified
- Fresh ws `/tmp/bl8` `init`: before 3✗ (hooks, mcp, plugin) → after only global-owned ✗ remain; files correct.
- Symlinked `beamline` on PATH → `init --global`: before 3✗ → after **all ✓, exit 0**.
- Local `doctor`: 9/9 ✓. Re-`init`: idempotent, no dup hooks, Doctor agent reused (still 1 agent).
- Detour fixed: `init --global` initially ran local flow (trailing-flag bug); also cleaned its stray `/private/tmp` writes.

## Not done (stays manual)
- `claude mcp add -s user beamline -- beamline mcp` — `claude` binary crashes in this env; printed as note by `init --global`.

## Next
Checkpoint 9: plugin `session.created`, tests, live both-scope verification, docs.
