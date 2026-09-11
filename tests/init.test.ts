import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChecks } from "../src/doctor";
import { mergeCcHooks, mergeOcMcp } from "../src/init";

const tmp = () => mkdtempSync(join(tmpdir(), "bl-"));

// ponytail: init/doctor tests hit the real filesystem in tmp dirs — no mocks,
// so a green run means the merge logic actually preserves user content.
describe("init merges", () => {
  test("cc hooks merge preserves user content, idempotent", () => {
    const d = tmp();
    const f = join(d, "settings.json");
    writeFileSync(f, JSON.stringify({ permissions: { allow: ["Bash"] }, hooks: { PreToolUse: [{ matcher: "X", hooks: [] }] } }));
    expect(mergeCcHooks(f).length).toBe(3);
    const after = JSON.parse(readFileSync(f, "utf8"));
    expect(after.permissions.allow).toEqual(["Bash"]);
    expect(after.hooks.PreToolUse.length).toBe(1);
    expect(JSON.stringify(after.hooks.SessionStart)).toContain("beamline link");
    expect(mergeCcHooks(f)).toEqual([]);
  });

  test("oc mcp merge preserves user content, idempotent", () => {
    const d = tmp();
    const f = join(d, "opencode.json");
    writeFileSync(f, JSON.stringify({ model: "x", mcp: { other: { type: "local", command: ["y"] } } }));
    expect(mergeOcMcp(f)).toBe(true);
    const after = JSON.parse(readFileSync(f, "utf8"));
    expect(after.model).toBe("x");
    expect(after.mcp.other.command).toEqual(["y"]);
    expect(after.mcp.beamline.command).toEqual(["beamline", "mcp"]);
    expect(mergeOcMcp(f)).toBe(false);
  });
});

describe("link + doctor matrix", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli.ts");
  const sh = (args: string[], cwd: string) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], { cwd });
    return { out: new TextDecoder().decode(p.stdout), code: p.exitCode };
  };

  test("link is idempotent per session", () => {
    const d = tmp();
    const a = JSON.parse(sh(["link", "--session", "s1"], d).out);
    const b = JSON.parse(sh(["link", "--session", "s1"], d).out);
    expect(a.id).toBe(b.id);
    expect(b.linked).toBe("existing");
  });

  test("doctor fail set on bare workspace, green after merges", async () => {
    const d = tmp();
    const cwd = process.cwd();
    process.chdir(d);
    try {
      const failed = (await collectChecks(false)).filter((c) => !c.ok).map((c) => c.name).sort();
      expect(failed).toEqual(["claude-hooks", "opencode-mcp"]);
      mergeCcHooks(join(d, ".claude", "settings.json"));
      mergeOcMcp(join(d, "opencode.json"));
      const failed2 = (await collectChecks(false)).filter((c) => !c.ok).map((c) => c.name);
      expect(failed2).toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });
});
