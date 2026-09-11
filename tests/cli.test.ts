import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const run = (args: string[], cwd: string, stdin?: string) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd, stdin: stdin ? Buffer.from(stdin) : undefined });
  return {
    code: p.exitCode,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
};
const tmp = () => mkdtempSync(join(tmpdir(), "bl-cli-"));

// ponytail: CLI surface tests assert UX contracts (help, errors, json-bytes),
// not mailbox logic — that's roundtrip.test.ts.
describe("cli surface", () => {
  test("bare invocation prints help, exit 0", () => {
    const r = run([], tmp());
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: beamline <command> [options]");
    expect(r.out).toContain("doctor");
  });

  test("--version matches package.json", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(run(["--version"], tmp()).out.trim()).toBe(pkg.version);
  });

  test("unknown command suggests", () => {
    const r = run(["snd"], tmp());
    expect(r.code).toBe(1);
    expect(r.err).toContain("Did you mean 'send'?");
  });

  test("missing required flag is actionable", () => {
    const r = run(["send", "--from", "x"], tmp());
    expect(r.code).toBe(1);
    expect(r.err).toContain("--to is required");
    expect(r.err).toContain("beamline send --help");
  });

  test("unknown flag names the problem", () => {
    const r = run(["poll", "--agent", "x", "--bogus"], tmp());
    expect(r.code).toBe(1);
    expect(r.err).toContain("--bogus");
  });

  test("per-command help", () => {
    const r = run(["wait", "--help"], tmp());
    expect(r.code).toBe(0);
    expect(r.out).toContain("beamline wait");
    expect(r.out).toContain("Examples:");
  });

  test("send to unknown agent is actionable, no stack", () => {
    const d = tmp();
    const r = run(["send", "--from", "a", "--to", "b", "--body", "hi"], d);
    expect(r.code).toBe(1);
    expect(r.err).toContain("beamline send: unknown sender: a.");
    expect(r.err).toContain("verify ids");
    expect(r.err).not.toContain("at error:");
  });

  test("--debug prints the stack", () => {
    const d = tmp();
    const r = run(["--debug", "send", "--from", "a", "--to", "b", "--body", "hi"], d);
    expect(r.code).toBe(1);
    expect(r.err).toContain("at ");
  });

  test("piped output stays JSON", () => {
    const d = tmp();
    run(["register", "--name", "Solo"], d);
    const agents = JSON.parse(run(["agents"], d).out);
    expect(agents[0]).toEqual({ id: expect.stringMatching(/^solo-/), name: "Solo" });
  });

  test("-C targets another workspace", () => {
    const d = tmp();
    const r = run(["-C", d, "agents"], tmp());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  test("completion scripts list commands", () => {
    for (const sh of ["bash", "zsh", "fish"]) {
      const r = run(["completion", sh], tmp());
      expect(r.code).toBe(0);
      expect(r.out).toContain("doctor");
    }
    expect(run(["completion", "tcsh"], tmp()).code).toBe(1);
  });

  test("doctor --help lists --fix", () => {
    const r = run(["doctor", "--help"], tmp());
    expect(r.code).toBe(0);
    expect(r.out).toContain("--fix");
  });

  test("workspace doctor --fix hints at --global, never touches user config", () => {
    const d = tmp();
    const r = run(["doctor", "--fix", "--json"], d);
    const checks = JSON.parse(r.out);
    expect(Array.isArray(checks)).toBe(true);
    expect(r.err).toContain("--global");
  });

  test("link writes JSON, wake resolves it via stdin", () => {
    const d = tmp();
    const linked = JSON.parse(run(["link", "--session", "s1"], d).out);
    const raw = readFileSync(join(d, ".beamline", "sessions", "s1"), "utf8");
    expect(JSON.parse(raw).id).toBe(linked.id);
    // bare-id legacy links still resolve
    writeFileSync(join(d, ".beamline", "sessions", "s2"), linked.id);
    const r = run(["wake"], d, JSON.stringify({ session_id: "s2" }));
    expect(r.code).toBe(0);
  });

  test("agents --stale + unlink --sweep reap dead links", () => {
    const d = tmp();
    const linked = JSON.parse(run(["link", "--session", "dead"], d).out);
    const p = join(d, ".beamline", "sessions", "dead");
    writeFileSync(p, JSON.stringify({ id: linked.id, pid: 99999999, updated: 0 }));
    utimesSync(p, new Date(0), new Date(0)); // mtime stale + pid dead
    const stale = JSON.parse(run(["agents", "--stale"], d).out);
    expect(stale.map((r: { session: string }) => r.session)).toEqual(["dead"]);
    const swept = JSON.parse(run(["unlink", "--sweep"], d).out);
    expect(swept.swept.join(",")).toContain("dead");
    expect(JSON.parse(run(["agents"], d).out)).toEqual([]);
  });

  test("log hides from poll, shows with --include-quiet", () => {
    const d = tmp();
    const a = JSON.parse(run(["register", "--name", "Alf"], d).out);
    run(["log", "--from", a.id, "--body", "status"], d);
    expect(JSON.parse(run(["poll", "--agent", a.id], d).out)).toEqual([]);
    const rows = JSON.parse(run(["poll", "--agent", a.id, "--include-quiet"], d).out);
    expect(rows.map((m: { body: string }) => m.body)).toContain("status");
  });

  test("doctor --json is parseable", () => {
    const d = tmp();
    const r = run(["-C", d, "doctor", "--json"], tmp());
    const checks = JSON.parse(r.out);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.map((c: { name: string }) => c.name)).toContain("bus-selftest");
  });

  test("link lifecycle: send→poll→ack→empty→unlink", () => {
    const d = tmp();
    const recv = JSON.parse(run(["link", "--session", "s-e2e", "--name", "E2E"], d).out);
    const send = JSON.parse(run(["register", "--name", "Peer"], d).out);
    const sent = JSON.parse(run(["send", "--from", send.id, "--to", recv.id, "--body", "hello", "--thread", "t1"], d).out);
    expect(sent.seq).toBeGreaterThan(0);
    const got = JSON.parse(run(["poll", "--agent", recv.id], d).out);
    expect(got.map((m: { body: string }) => m.body)).toEqual(["hello"]);
    run(["ack", "--agent", recv.id, "--upto", String(sent.seq)], d);
    expect(JSON.parse(run(["poll", "--agent", recv.id], d).out)).toEqual([]);
    const un = JSON.parse(run(["unlink", "--session", "s-e2e"], d).out);
    expect(un.ok).toBe(true);
    const agents = JSON.parse(run(["agents"], d).out);
    expect(agents.map((a: { id: string }) => a.id)).not.toContain(recv.id);
  });
});
