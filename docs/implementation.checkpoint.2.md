# Checkpoint 2 — MCP stdio server (DONE)

## Built
- `src/index.ts` — `McpServer` + `StdioServerTransport`, 7 tools: `beamline_register/send/broadcast/poll/wait/ack/list_agents`
- DB resolves to `<cwd>/.beamline/beamline.db` (`mkdir -p`), so workspace = process cwd. Zero config.
- Added `zod` (tool schemas; the SDK's own pattern — no way around it with `registerTool`).

## Verified (live MCP client over stdio, workspace /tmp/bl-ws)
- `tools/list` → all 7 names
- `register{name:Apollo}` → `apollo-fff6`; bare `register` → `nova-ac11` (random codename)
- `send` + `broadcast`, then `poll(nova)` → `[seq1 direct, seq2 broadcast]`
- `.beamline/beamline.db` created in client cwd

## Skipped / deferred
- HTTP/SSE transport — not needed for local harnesses.
- Auth — local file, OS permissions are the boundary.

## Next
Phase 3: `src/cli.ts` (`poll|ack|wait|register|send`) + `.beamline/wake.sh` hook adapter.
