# Checkpoint 1 — store + scaffold (DONE)

## Built
- `package.json` (beamline 0.1.0, scripts: server/cli/test, dep: `@modelcontextprotocol/sdk@1.30.0`)
- `tsconfig.json` (strict, bundler resolution, bun types)
- `src/store.ts` — `openStore(dbPath)` returning `{register, agent, listAgents, send, broadcast, poll, wait, ack, cursor}`
  - Tables: `agents(id, name, created_at)`, `messages(seq AUTOINCREMENT, from_id, to_id NULL=broadcast, thread_id, body, created_at)`, `cursors(agent_id, upto_seq)`
  - Broadcast = single row `to_id NULL`; `poll` ORs it into every agent's view. No fan-out rows.
  - IDs: `<name>-<4 hex>` from `crypto.randomUUID()` (stdlib, no nanoid).
  - `wait` = sleep-poll loop (250ms).

## Verified (live run, /tmp/bl-check/t.db)
- `register("Apollo")` → `apollo-b946`, `register("Astra")` → `astra-7e27`
- `send(apollo→astra)` seq 1; `broadcast(apollo)` seq 2
- `poll(astra)` → [1, 2]; `poll(apollo)` → [2] (sender doesn't get own direct back, does see broadcast)
- `ack(astra, 2)` → `poll` → `[]`
- `wait(astra, 99, 1000)` → `[]` after 1005ms

## Skipped / deferred
- Fan-out rows, topics, presence, auth — add when needed.
- `wait` has a `ponytail:` comment (sleep-poll ceiling → SSE/broker when multi-host).

## Next
Phase 2: `src/index.ts` MCP stdio server exposing the 7 tools.
