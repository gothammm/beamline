import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

  test("doctor --json is parseable", () => {
    const d = tmp();
    const r = run(["-C", d, "doctor", "--json"], tmp());
    const checks = JSON.parse(r.out);
    expect(Array.isArray(checks)).toBe(true);
    expect(checks.map((c: { name: string }) => c.name)).toContain("bus-selftest");
  });
});
