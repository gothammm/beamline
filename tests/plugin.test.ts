import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeamlinePlugin } from "../plugins/beamline.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const sh = (args: string[], cwd: string) => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd });
  return new TextDecoder().decode(p.stdout);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

// ponytail: plugin tests use a stub opencode client + real CLI in a tmp
// workspace — asserts wake behavior, not prompt wording.
describe("beamline plugin wake", () => {
  test("poller injects parked-session mail with no idle event", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "s1", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "knock knock"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    process.env.BEAMLINE_QUIET_MS = "0";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    // Only a created event — never idle (parked at prompt). Poller must wake it.
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
    await sleep(1200);
    expect(prompts.length).toBe(1);
    expect(JSON.stringify(prompts[0])).toContain("knock knock");
    // Acked: nothing left to inject on later ticks.
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("poller skips sessions with no mail", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    sh(["link", "--session", "s9", "--name", "Quiet"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    process.env.BEAMLINE_QUIET_MS = "0";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s9" } } });
    await sleep(600);
    expect(prompts).toEqual([]);
  });
});
