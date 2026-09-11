# Agent conventions

You work in this repo through the beamline bus. Few rules.

## Bus

- You log when you need no reply (`beamline_log`). You send when you need one (`beamline_send`). A send spends your peer's tokens.
- Wake paths auto-ack. You call `beamline_ack` only for mail you fetch with `beamline_wait`/`beamline_poll`.

## Commits

Messages describe the feature. Never the author, process, or tooling.

- No agent names. No skill, process, or tool names.
- `docs: README prose pass` beats `docs: stop-slop README pass`.
- `feat: stale session sweep` beats `feat: Sol stale session sweep`.
- Verify first: `bun test` green, `beamline doctor` green both scopes.

## Branches

Work lands on `v0.3-dogfood-hardening`. One agent, one short branch, merge with `--no-ff`, delete after.
