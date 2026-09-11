import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChecks } from "../src/doctor";
import { installOcPlugin, mergeCcHooks, mergeMcpJson, mergeOcMcp } from "../src/init";

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

  test("mcp.json merge preserves other servers, idempotent", () => {
    const d = tmp();
    const f = join(d, ".mcp.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect(mergeMcpJson(f)).toBe(true);
    const after = JSON.parse(readFileSync(f, "utf8"));
    expect(after.mcpServers.other).toEqual({ command: "x" });
    expect(after.mcpServers.beamline).toEqual({ command: "beamline", args: ["mcp"] });
    expect(mergeMcpJson(f)).toBe(false);
  });

  test("plugin copy skips write when current", () => {
    const d = tmp();
    const f = join(d, "beamline.js");
    expect(installOcPlugin(f)).toBe(true);
    expect(installOcPlugin(f)).toBe(false);
    expect(readFileSync(f, "utf8")).toContain("BeamlinePlugin");
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
      // Workspace init fixes claude-hooks + opencode-mcp + opencode-plugin;
      // cli-on-path + mcp-server stay environment-dependent, so assert subset.
      expect(failed).toContain("claude-hooks");
      expect(failed).toContain("opencode-mcp");
      expect(failed).toContain("opencode-plugin");
      mergeCcHooks(join(d, ".claude", "settings.json"));
      mergeOcMcp(join(d, "opencode.json"));
      installOcPlugin(join(d, ".opencode", "plugins", "beamline.js"));
      const failed2 = (await collectChecks(false)).filter((c) => !c.ok).map((c) => c.name);
      expect(failed2).not.toContain("claude-hooks");
      expect(failed2).not.toContain("opencode-mcp");
      expect(failed2).not.toContain("opencode-plugin");
    } finally {
      process.chdir(cwd);
    }
  });

  test("init wires a bare workspace end to end", async () => {
    const d = tmp();
    sh(["init"], d);
    for (const f of [".beamline/sessions", ".claude/settings.json", "opencode.json", ".opencode/plugins/beamline.js", ".mcp.json"]) {
      expect(existsSync(join(d, f))).toBe(true);
    }
    // Second run: idempotent, workspace checks green.
    sh(["init"], d);
    const cwd = process.cwd();
    process.chdir(d);
    try {
      const failed = (await collectChecks(false)).filter((c) => !c.ok).map((c) => c.name);
      expect(failed).not.toContain("claude-hooks");
      expect(failed).not.toContain("opencode-mcp");
      expect(failed).not.toContain("opencode-plugin");
    } finally {
      process.chdir(cwd);
    }
  });
});
