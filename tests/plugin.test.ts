import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    // Only a created event — never idle (parked at prompt). Poller must wake it.
    // (Already linked, so no identity prompt — just the mail prompt.)
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
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "s9" } } });
    await sleep(600);
    // Already linked and no mail: total silence (identity fires only on new binds).
    expect(prompts).toEqual([]);
  });

  test("batch injects all mail in one prompt, then acks to empty", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "s2", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    for (const body of ["one", "two", "three"]) sh(["send", "--from", send.id, "--to", recv.id, "--body", body], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
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

  test("burst over the batch cap drains across ticks with nothing lost", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "sburst", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    const bodies = Array.from({ length: 25 }, (_, i) => `burst-${i}`);
    for (const body of bodies) sh(["send", "--from", send.id, "--to", recv.id, "--body", body], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000"; // slow poller: explicit idle events drive each batch
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "sburst" } } });
    expect(prompts).toEqual([]); // pre-linked: no identity prompt
    // First batch: capped at 20, overflow stays queued (would have been acked
    // unseen before the cap fix).
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sburst" } } });
    const pending = JSON.parse(sh(["poll", "--agent", recv.id], d)).map((m: { body: string }) => m.body);
    expect(pending).toEqual(bodies.slice(20));
    expect(JSON.stringify(prompts[0])).toContain("burst-0");
    expect(JSON.stringify(prompts[0])).not.toContain("burst-20");
    // Next tick drains the rest; every body delivered exactly once overall.
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sburst" } } });
    expect(prompts.length).toBe(2);
    const seen = prompts.flatMap((p) => bodies.filter((b) => JSON.stringify(p).includes(b)));
    expect([...new Set(seen)].sort()).toEqual([...bodies].sort());
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("auto-inject prompt says auto-acked, never asks for manual ack", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "s3", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "wording"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
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
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_su1" } } });
    await sleep(300);
    expect(prompts.length).toBe(1);
    const text = JSON.stringify(prompts[0]);
    expect(text).toContain("never beamline_register again");
    expect(text).toContain("ses_su1");
  });

  test("restart heals: link file with zero events still injects", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "sr", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "after restart"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
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

  test("delivery is instant despite session activity — no quiet gate", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "sa", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "urgent"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (a: unknown) => void prompts.push(a) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "sa" } } });
    // Constant activity while the poller runs — delivery must not wait for quiet.
    for (let i = 0; i < 5; i++) {
      await plugin.event({ event: { type: "message.updated", properties: { sessionID: "sa" } } });
      await sleep(100);
    }
    await sleep(400);
    const found = prompts.filter((p) => JSON.stringify(p).includes("urgent"));
    expect(found.length).toBe(1);
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("hanging prompt times out — mail retained, retried, never wedged", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "sh", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "stuck"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    process.env.BEAMLINE_PROMPT_MS = "200";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: () => new Promise(() => {}) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sh" } } });
    await sleep(700);
    expect(prompts).toEqual([]);
    // Not acked: still waiting for the next tick.
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d)).map((m: { body: string }) => m.body)).toEqual(["stuck"]);
    expect(readFileSync(join(d, ".beamline", "oc-events.log"), "utf8")).toContain("prompt timeout");
  });

  test("two copies single-flight: one prompt total, acked once", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "sd", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "once only"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    const a: unknown[] = [];
    const b: unknown[] = [];
    // No events: both pollers find the session via rescan, like global+project copies.
    await BeamlinePlugin({
      client: { session: { prompt: async (p: unknown) => void a.push(p) } },
      directory: d,
    });
    await BeamlinePlugin({
      client: { session: { prompt: async (p: unknown) => void b.push(p) } },
      directory: d,
    });
    await sleep(900);
    expect(a.length + b.length).toBe(1);
    expect(JSON.stringify([...a, ...b][0])).toContain("once only");
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("created announces identity only on new binds", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000"; // slow poller: only created prompts fire
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (p: unknown) => void prompts.push(p) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_sx1" } } });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "ses_sx1" } } });
    await sleep(300);
    expect(prompts.length).toBe(1);
    expect(JSON.stringify(prompts[0])).toContain("never beamline_register again");
  });

  test("load reconciles missed sessions silently, scoped to this project", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: {
        session: {
          prompt: async (p: unknown) => void prompts.push(p),
          list: async () => [
            { id: "ses_mine1", projectID: "p1", directory: d },
            { id: "ses_bare1", directory: d },
            { id: "foreign", projectID: "other", directory: "/elsewhere" },
          ],
        },
      },
      directory: d,
      project: { id: "p1" },
    });
    // Reconcile runs in the background (never blocks plugin load) and logs
    // nothing on success — allow it to finish before asserting.
    await sleep(500);
    // History alone links nothing and registers no agents: a live session
    // proves itself by emitting events, and links lazily on the first one.
    expect(JSON.parse(sh(["agents"], d))).toEqual([]);
    expect(existsSync(join(d, ".beamline", "sessions", "ses_mine1"))).toBe(false);
    expect(existsSync(join(d, ".beamline", "sessions", "ses_bare1"))).toBe(false);
    expect(existsSync(join(d, ".beamline", "sessions", "foreign"))).toBe(false);
    expect(prompts).toEqual([]);
    // First live event for a listed session binds it silently (no identity
    // prompt — the session is already working, never interrupt it).
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_mine1" } } });
    expect(existsSync(join(d, ".beamline", "sessions", "ses_mine1"))).toBe(true);
    expect(existsSync(join(d, ".beamline", "sessions", "ses_bare1"))).toBe(false);
    expect(JSON.parse(sh(["agents"], d)).length).toBe(1);
    expect(prompts).toEqual([]);
  });

  test("history burst registers zero agents until a session goes live", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000";
    const history = Array.from({ length: 25 }, (_, i) => ({ id: `dead-${i}`, directory: d }));
    const prompts: unknown[] = [];
    await BeamlinePlugin({
      client: { session: { prompt: async (p: unknown) => void prompts.push(p), list: async () => history } },
      directory: d,
    });
    await sleep(500);
    expect(JSON.parse(sh(["agents"], d))).toEqual([]);
    expect(prompts).toEqual([]);
  });

  test("two copies racing one new session register a single agent", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000";
    const a: unknown[] = [];
    const b: unknown[] = [];
    const mk = (s: unknown[]) =>
      BeamlinePlugin({ client: { session: { prompt: async (p: unknown) => void s.push(p) } }, directory: d });
    const pa = await mk(a);
    const pb = await mk(b);
    await Promise.all([
      pa.event({ event: { type: "session.created", properties: { sessionID: "ses_race1" } } }),
      pb.event({ event: { type: "session.created", properties: { sessionID: "ses_race1" } } }),
    ]);
    await sleep(300);
    expect(JSON.parse(sh(["agents"], d)).length).toBe(1);
    expect(a.length + b.length).toBe(1);
  });

  test("non-session event ids never link or register (provider-name junk repro)", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "50";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (p: unknown) => void prompts.push(p) } },
      directory: d,
    });
    // Bare properties.id from unrelated events (providers, commands, …).
    await plugin.event({ event: { type: "session.created", properties: { id: "openai" } } });
    await plugin.event({ event: { type: "message.updated", properties: { id: "groq" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "command" } } });
    await sleep(600);
    expect(JSON.parse(sh(["agents"], d))).toEqual([]);
    expect(existsSync(join(d, ".beamline", "sessions"))).toBe(false);
    expect(prompts).toEqual([]);
  });

  test("timed-out prompt is not re-injected until newer mail arrives", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    const recv = JSON.parse(sh(["link", "--session", "ses_timeout1", "--name", "Recv"], d));
    const send = JSON.parse(sh(["register", "--name", "Send"], d));
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "first"], d);

    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000"; // slow poller: explicit idle events only
    process.env.BEAMLINE_PROMPT_MS = "200";
    let hang = true;
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: {
        session: {
          prompt: async (p: unknown) => {
            if (hang) return new Promise(() => {}); // server takes it, never answers in time
            prompts.push(p);
          },
        },
      },
      directory: d,
    });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_timeout1" } } });
    await sleep(500); // timeout fired, attempt recorded, mail retained
    expect(prompts).toEqual([]);
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d)).map((m: { body: string }) => m.body)).toEqual(["first"]);
    hang = false;
    // Nothing new: must NOT re-prompt (the timed-out attempt usually lands
    // late on its own — retrying injects a visible duplicate).
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_timeout1" } } });
    await sleep(300);
    expect(prompts).toEqual([]);
    // Fresh mail: whole pending range goes out exactly once, then acked.
    sh(["send", "--from", send.id, "--to", recv.id, "--body", "second"], d);
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_timeout1" } } });
    expect(prompts.length).toBe(1);
    const text = JSON.stringify(prompts[0]);
    expect(text).toContain("first");
    expect(text).toContain("second");
    expect(JSON.parse(sh(["poll", "--agent", recv.id], d))).toEqual([]);
  });

  test("init never blocks on a hanging session list (silent no-launch repro)", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000";
    const plugin = await Promise.race([
      BeamlinePlugin({
        client: { session: { prompt: async () => {}, list: () => new Promise(() => {}) } },
        directory: d,
      }),
      sleep(2000).then(() => {
        throw new Error("plugin init blocked startup");
      }),
    ]);
    expect(typeof plugin.event).toBe("function");
  });

  test("init tolerates a client with no session object", async () => {
    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    process.env.BEAMLINE_HOME = join(import.meta.dir, "..");
    process.env.BEAMLINE_POLL_MS = "60000";
    const plugin = await BeamlinePlugin({ client: {}, directory: d });
    expect(typeof plugin.event).toBe("function");
  });

  test("missing CLI never throws — events degrade to logged no-ops", async () => {    const d = mkdtempSync(join(tmpdir(), "bl-plugin-"));
    // Bogus BEAMLINE_HOME: `bun <missing>/src/cli.ts` exits nonzero with no
    // stdout — same degraded path as a `beamline` binary missing from GUI PATH
    // (Bun resolves PATH at startup, so blanking PATH mid-process can't
    // simulate it; both funnel through sh() returning "").
    process.env.BEAMLINE_HOME = join(tmpdir(), "bl-no-such-dir");
    process.env.BEAMLINE_POLL_MS = "60000";
    const prompts: unknown[] = [];
    const plugin = await BeamlinePlugin({
      client: { session: { prompt: async (p: unknown) => void prompts.push(p) } },
      directory: d,
    });
    await plugin.event({ event: { type: "session.created", properties: { sessionID: "sx" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "sx" } } });
    await sleep(300);
    expect(prompts).toEqual([]);
  });
});
