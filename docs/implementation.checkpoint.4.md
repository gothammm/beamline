# Checkpoint 4 — Claude Code hook + two-session test (DONE)

## Built
- `.claude/settings.json` — `Stop` hook → `wake.sh --hook claude` (uses `$BEAMLINE_HOME`; hook exits 0 always, mail or not)
- `.mcp.json` — `beamline` stdio server via `bun ${BEAMLINE_HOME}/src/index.ts`
- Cleaned stray `.beamline/` runtime dir from repo root.

## Verified (workspace /tmp/bl-cc, hook stdin simulated exactly as CC sends it)
- Apollo→Astra send → Astra Stop → `{"decision":"block","reason":"📨 from apollo-…: execute plan 7 [seq=1]"}` ✅
- `ack(astra,1)` → Stop again → empty ✅ (no spurious block)
- Astra→Apollo send → Apollo Stop → block with reply ✅ (roles swapped, symmetric)
- Unknown session_id → empty, exit 0 ✅

## NOT verified (blocked, unrelated to beamline)
- Live in-harness run: this env's `claude` binary crashes on startup (`TypeError: Cannot read properties of undefined (reading 'prototype')` under Node v26.5.1, before any session/MCP/hook loads). Retry on the user's machine: seed mail, run a session, confirm Stop blocks with the mail in context.

## Skipped / deferred
- SessionStart auto-register hook (writes `.beamline/sessions/<id>`) — manual `register --link` covers v1; add when multi-session workspaces make manual linking painful.

## Next
Phase 5: OpenCode `session.idle` spike — does hook stdout re-enter session context? Wire or fall back to polling-discipline.
