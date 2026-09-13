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
    // (Created also fires one identity prompt; the mail prompt is the 1 match.)
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s1" } } });
    await sleep(1200);
    const found = prompts.filter((p) => JSON.stringify(p).includes("knock knock"));
    expect(found.length).toBe(1);
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
    // Only the created-time identity prompt; no mail prompt.
    expect(prompts.length).toBe(1);
    expect(JSON.stringify(prompts[0])).toContain("never beamline_register again");
  });

  test("batch injects all mail in one prompt, then acks to empty", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "s2", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    for (const body of ["one", "two", "three"]) sh(["send", "--from", send.id, "--to", recv.id, "--body", body], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    process.env.BEAMLINE_QUIET_MS = "0";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s2" } } });
    await sleep(1200);
    const batched = prompts.filter((p) => JSON.stringify(p).includes("two"));
    expect(batched.length).toBe(1);
    const text = JSON.stringify(batched[0]);
    for (const body of ["one", "two", "three"]) expect(text).toContain(body);
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("auto-inject prompt says auto-acked, never asks for manual ack", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "s3", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "wording"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    process.env.BEAMLINE_QUIET_MS = "0";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s3" } } });
    await sleep(1200);
    const injected = prompts.filter((p) => JSON.stringify(p).includes("auto-acked"));
    expect(injected.length).toBe(1);
    const text = JSON.stringify(injected[0]);
    expect(text).toContain("auto-acked");
    expect(text).not.toContain("then beamline_ack");
  });

  test("failed inject does not ack — mail redelivered on retry", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "s4", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "retry me"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    // Slow poller so only our explicit idle events drive injects.
    process.env.BEAMLINE_POLL_MS = "60000";
    process.env.BEAMLINE_QUIET_MS = "0";
    let fail = true;
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: {
        session: {
          prompt: async (a: unknown) => {
            if (fail) throw new Error("inject boom");
            prompts.push(a);
          },
        },
      },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s4" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s4" } } });
    // Failed inject: mail retained.
    expect(prompts).toEqual([]);
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d)).map((m: { body: string }) => m.body)).toEqual(["retry me"]);
    fail = false;
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "s4" } } });
    expect(prompts.length).toBe(1);
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("created tells the session its id — no duplicate registration needed", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000"; // slow poller: only the created prompt fires
    process.env.BEAMLINE_QUIET_MS = "0";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "su" } } });
    await sleep(300);
    expect(prompts.length).toBe(1);
    const text = JSON.stringify(prompts[0]);
    expect(text).toContain("never beamline_register again");
    expect(text).toContain("su");
  });

  test("restart heals: link file with zero events still injects", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "sr", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "after restart"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    process.env.BEAMLINE_QUIET_MS = "0";
    const prompts: unknown[] = [];
    // No events fired at all: simulates a server restart wiping known.
    await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await sleep(800);
    expect(prompts.length).toBe(1);
    expect(JSON.stringify(prompts[0])).toContain("after restart");
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });
});
