# Checkpoint 10 — proper CLI per nodejs-cli-apps-best-practices (DONE)

## What was wrong
Single `usage: beamline a|b|c…` line on every failure; hand-rolled parser (already caused one real bug: `--global` swallowed); raw sqlite stacks on user errors; no `--help`, no `--version`, no completion; JSON-only output even for humans.

## Built (zero new deps — `node:util` parseArgs + styleText, per the guide)
- `src/commands.ts` (new) — all 12 commands as data `{name, description, options, examples, run}`; mailbox logic moved verbatim; per-command `parseArgs` strict (unknown flags rejected); `need()` required-flag validation.
- `src/cli.ts` — thin dispatcher (~120 lines): global pre-scan (`-h/--help`, `--version` from package.json, `--debug`, `--json`, `-C/--workspace` with chdir), bare → help exit 0, unknown → edit-distance suggestion, `<cmd> --help`.
- `src/output.ts` (new) — TTY gate (human tables on terminal, byte-stable JSON piped), `fail()` actionable errors (`beamline <cmd>: <msg>. Fix: <fix>. See help.`), `crash()` (stacks only under `--debug`/`DEBUG=beamline*`), NO_COLOR-aware color.
- `src/completion.ts` (new) — bash/zsh/fish generated from the table.
- `src/doctor.ts` — `runDoctor(global, json)`; `doctor --json` for scripts.
- `package.json` — version 0.2.0, `files` field (7.3). `src/index.ts` MCP version bumped to match.

## Guide mapping
1.1 parseArgs+shorts · 1.2 did-you-mean · 1.9 help+examples · 3.2 --json/structured · 3.4 flag>env>link + -C · 3.6 data-stdout/diag-stderr · 3.7 completion · 4.2 TTY-graceful/NO_COLOR · 6.2 actionable · 6.3 debug · 6.4 exit 0/1 · 9.1 --version · 2.1/7.x zero-dep/bin/files. Deliberately skipped: numeric error codes (prefixed+actionable instead — 12 commands don't need E-codes), prompts (nothing interactive to gate), analytics (none).

## Verified
- Contract freeze: 10 piped-output fixtures captured pre-rewrite (`/tmp/blfreeze`), re-run post-rewrite — all SAME (one apparent diff was the test re-linking, proving idempotence again).
- `bun test`: 22 pass (10 old + 12 new CLI surface: help, version, suggest, missing/unknown flags, no-stack/stack, piped-JSON, -C, completion×3+reject, doctor--json).
- `doctor` + `doctor --global` all green post-rewrite; MCP smoke passes through new dispatcher.
- pty check: bold table output on terminal, `(no mail)` gray empty-state.

## Skipped (ledger)
Man pages (help text covers it), zsh completion live-load test (static output inspected only).
