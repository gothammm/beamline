# Checkpoint 3 — CLI + wake.sh (DONE)

## Built
- `src/cli.ts` — `register|send|broadcast|poll|wait|ack|agents`, hand-rolled argv (no parser dep). `register --link <key>` writes `.beamline/sessions/<key>` → agent id (hook identity mapping). `poll --hook lines|claude`: lines = `📨` model-ready lines; claude = full Stop-blocking JSON (empty mail → silent exit 0).
- `wake.sh` (repo root, sh, exit-0-always) — agent resolution: `$1` → `$BEAMLINE_AGENT` → `.beamline/sessions/<$BEAMLINE_SESSION|stdin session_id>`; delegates formatting to CLI. `BIN` defaults to alongside-repo `src/cli.ts`, overridable via `$BEAMLINE_BIN`.

## Verified (workspace /tmp/bl-cli)
- register Apollo/Astra, `--link sess123` file created, `agents` lists both
- send + broadcast → wake lines shows both with seq; `--hook claude` emits `{"decision":"block","reason":"..."}`; session-link resolution works; no-agent → empty, exit 0
- `wait --after 2 --timeout 10000` returned seq 3 after 2.3s (delayed background send)

## Skipped / deferred
- Auto-ack on hook delivery — agent acks explicitly after reading (at-least-once > at-most-once).
- Non-zero-exit error traces from CLI on bad ids — acceptable for v1.

## Next
Phase 4: `.claude/settings.json` Stop hook → wake.sh + live two-session test (Apollo sends, Astra's Stop blocks with mail, then reversed).
