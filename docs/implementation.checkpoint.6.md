# Checkpoint 6 — tests + docs + ship (DONE)

## Built
- `tests/roundtrip.test.ts` — 6 tests, 6 pass: ids, direct-only delivery, broadcast fan-in, ack cursors, wait-resolves-on-send (300ms delayed send), wait-timeout-empty. (`bun test`, ~1s.)
- `README.md` — model + setup + file map, no prose tours.
- `.gitignore` — `.beamline/` (runtime state) + `node_modules/`.
- Cleaned stray `.beamline/` from repo root (twice — CLI resolves db from cwd; tests must run from the repo).

## Final tree
`src/{store,index,cli}.ts`, `wake.sh`, `plugins/beamline.js`, `.opencode/plugins/beamline.js → symlink`, `.claude/settings.json`, `.mcp.json`, `opencode.json`, `tests/`, `docs/`, `README.md`. Deps: `@modelcontextprotocol/sdk`, `zod`. That's it.

## Verification summary (all phases)
| Claim | Status |
|---|---|
| store: send/broadcast/poll/ack/wait | live ✅ + tests ✅ |
| MCP stdio: 7 tools, real client | live ✅ |
| CLI + wake.sh: all id sources, both hook formats, wait-resolves | live ✅ |
| CC Stop → block JSON both directions + ack-clears + unknown-empty | simulated hook stdin ✅; in-harness run blocked (broken `claude` binary in this env) ⚠️ |
| OC `session.idle` → mail as user turn | transcript-verified ✅; MCP connected ✅ |
| OC headless `run` continues the injected turn | NO — stores, doesn't continue ⚠️ (TUI does; `wait`-discipline covers `run`) |

## Skipped (ponytail ledger)
- Daemon, SSE/HTTP, Redis/NATS, topics, auth, presence, mid-generation interrupt, third-party hook plugins, SessionStart auto-register, arg-parser lib, nanoid. Add each when a real harness pain demands it.
- `ponytail:` markers in code: sleep-poll `wait` (→ notify when multi-host), hand-rolled argv (→ parser past ~6 cmds), hook-lines format (→ new formats per harness), plugin in-flight guard (→ lockfile for multi-server), CLI-shellout from plugin (stays).

## User-verifiable (needs working harness UIs)
1. TUI OpenCode: seed mail, watch idle session wake with it in context.
2. Claude Code: same via Stop hook (needs working `claude` CLI).
