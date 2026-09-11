# Checkpoint 5 — OpenCode spike: PASS (native, no extra deps)

## Spike question
Can a NATIVE OpenCode hook put beamline mail into a session's context (no third-party plugin)? → **Yes.**

## Built
- `plugins/beamline.js` (~90 lines, zero deps) — `session.idle` event → resolve agent (`$BEAMLINE_AGENT` or `.beamline/sessions/<oc-session-id>`) → `CLI poll` → `client.session.prompt({path:{id}, body:{parts:[mail]}})` → `CLI ack`. In-flight guard per session kills the double-idle duplicate-prompt race.
- `opencode.json` (repo dogfood) — MCP `beamline` via relative `bun src/index.ts` (verified: OC resolves against project dir; `${VAR}` is NOT expanded — tested, fails).
- `.opencode/plugins/beamline.js` → symlink to `../../plugins/beamline.js`.

## Verified live (opencode 1.18.30, workspace /tmp/bl-oc, real model calls)
- `session.idle` fires with `event.properties = {sessionID}` (shape logged).
- `opencode mcp list` → `beamline ✓ connected` (both absolute test-ws config and relative repo config).
- `opencode run "Reply with exactly: ready"` with seeded Apollo→Astra mail → session transcript (`opencode export`) shows: `user: ready-prompt / assistant: ready / user: New beamline mail — … PLAN SEVEN RECEIVED [seq=2]`. **Mail landed as a user turn with zero human action.** Plugin acked (cursor advanced 1→2).
- Failure detours that proved out: `[]` poll was my shell's cwd (`/private/tmp` quirk), not a beamline bug; unacked-mail mystery was a successful silent inject+ack from the prior run.

## Caveats (honest)
- Headless `opencode run` STORES the injected turn but exits without running a model turn on it (output was just `ready`). Interactive modes (TUI/serve/web) continue turning on new user messages — that's where executor agents live. User to confirm in TUI.
- `session.prompt` from inside an idle handler is fire-and-observe; errors are caught and logged to `.beamline/oc-events.log`.
- Polling-discipline fallback (`beamline_wait` at end of turn) still works everywhere, including `run` mode, with no hooks at all.

## Next
Phase 6: `bun:test` round-trip + final docs (README quickstart, envcontract).
