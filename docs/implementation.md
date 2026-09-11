# Beamline — implementation log

Live tracker. Each phase ends with a `docs/implementation.checkpoint.<n>.md` snapshot; the newest section here always mirrors the latest checkpoint.

## Checkpoint 1 — store (DONE)
`src/store.ts` over `bun:sqlite`. Verified live: direct send, broadcast fan-in, ack cursors, `wait` 1s timeout → `[]`. Details: `docs/implementation.checkpoint.1.md`.

## Checkpoint 2 — MCP server (DONE)
`src/index.ts`, 7 tools live over stdio, verified with real client. Details: `docs/implementation.checkpoint.2.md`.

## Checkpoint 3 — CLI + wake (DONE)
`src/cli.ts` + `wake.sh`, all resolution paths + both hook formats verified live. Details: `docs/implementation.checkpoint.3.md`.

## Checkpoint 4 — CC hook + two-session test (DONE)
`.claude/settings.json` + `.mcp.json`; full send→Stop-block→ack→empty loop verified both directions. Live harness run blocked by broken `claude` binary in this env. Details: `docs/implementation.checkpoint.4.md`.

## Checkpoint 5 — OC spike PASS (DONE)
Native `session.idle` plugin injects mail as a user turn (transcript-verified); MCP connected; repo dogfood `opencode.json` + symlinked plugin. Caveat: headless `run` stores but doesn't continue the turn — TUI does. Details: `docs/implementation.checkpoint.5.md`.

## Checkpoint 6 — ship (DONE)
6/6 tests green; README + .gitignore; full verification matrix. Two user-side confirmations left (TUI wake, CC live run). Details: `docs/implementation.checkpoint.6.md`.

## Checkpoint 7 — CLI surface (DONE)
`bin` packaging, `mcp`/`link`/`wake` subcommands, `wake.sh` deleted, link idempotent. Details: `docs/implementation.checkpoint.7.md`.

## Checkpoint 8 — doctor + init (DONE)
8-check doctor + merge-only init, both scopes; global install live on PATH, `init --global` → all green. Details: `docs/implementation.checkpoint.8.md`.

## Checkpoint 9 — auto-register + verification (DONE)
`session.created` auto-link, identity-in-prompt fix (verified: model acked as its linked id), 10/10 tests, both scopes proven live with zero per-session steps. Details: `docs/implementation.checkpoint.9.md`.

## Checkpoint 10 — proper CLI (DONE)
Table-driven rewrite per nodejs-cli-apps-best-practices (parseArgs, help, suggestions, actionable errors, TTY-gated output, completion, --version/--debug/--json/-C). Piped contracts byte-frozen, 22/22 tests. Details: `docs/implementation.checkpoint.10.md`.
