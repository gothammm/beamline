# Checkpoint 7 — CLI surface: `mcp`/`link`/`wake` (DONE)

## Built
- `package.json` `bin: {beamline: ./src/cli.ts}` + shebang → global install = symlink into `~/.bun/bin` (`bun install -g` doesn't install local checkouts; `npm -g` would run it under node — wrong runtime. Symlink documented as the install).
- `src/index.ts` — server body wrapped in exported `runServer()` (+ `import.meta.main` guard, no behavior change).
- `src/cli.ts` — lazy `useStore()` (mailbox cmds only), shared `printHook`, stdin/session-link agent resolution; new subcommands:
  - `mcp` → `runServer()` (workspace MCP = `beamline mcp`, zero paths)
  - `link` → SessionStart: stdin `{session_id}` or `--session`; idempotent per session (`existing` vs `new`)
  - `wake [--hook]` → subsumes `wake.sh` (**deleted**)
- Fixed `opt()` to return `true` for trailing flags (was swallowing `--global`).

## Verified (/tmp/bl7)
- `link` → `comet-c4ef/new`; re-link → same id/`existing`; `--session sess-B` → `luna-ef1e`
- `send` + `wake --hook claude` via session stdin → block JSON; re-wake unacked → re-blocks (at-least-once ✓)

## Next
Checkpoint 8: doctor + init (done, writing up).
