import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store";

// ponytail: one round-trip file is the whole suite; add cases only when a regression bites.
describe("beamline round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "bl-"));
  const store = openStore(join(dir, "t.db"));
  const apollo = store.register("Apollo");
  const astra = store.register("Astra");

  test("ids are namespaced + unique", () => {
    expect(apollo.id.startsWith("apollo-")).toBe(true);
    expect(astra.id).not.toBe(apollo.id);
  });

  test("direct goes to recipient only", () => {
    store.send(apollo.id, astra.id, "plan 7");
    expect(store.poll(astra.id).map((m) => m.body)).toEqual(["plan 7"]);
    expect(store.poll(apollo.id)).toEqual([]);
  });

  test("broadcast reaches everyone except the sender's own echo", () => {
    store.broadcast(apollo.id, "standup");
    expect(store.poll(apollo.id).map((m) => m.body)).toEqual([]);
    expect(store.poll(astra.id).map((m) => m.body)).toContain("standup");
  });

  test("shared db file serves two handles without busy errors", () => {
    const db2 = openStore(join(dir, "t.db"));
    const senders = Array.from({ length: 10 }, (_, i) => store.register(`Hammer${i}`));
    for (const s of senders) {
      db2.send(s.id, apollo.id, "hammer");
      store.ack(s.id, 1);
    }
    expect(store.poll(apollo.id).map((m) => m.body).filter((b) => b === "hammer").length).toBe(10);
  });

  test("ack advances cursor", () => {
    store.ack(astra.id, 99);
    expect(store.poll(astra.id)).toEqual([]);
  });

  test("wait resolves on send", async () => {
    const bob = store.register("Bob");
    const after = store.poll(bob.id).at(-1)?.seq ?? store.cursor(bob.id); // skip pre-existing broadcasts
    setTimeout(() => store.send(apollo.id, bob.id, "ping"), 300);
    const got = await store.wait(bob.id, after, 5000);
    expect(got.map((m) => m.body)).toEqual(["ping"]);
  });

  test("new agent starts past historic broadcasts", () => {
    store.broadcast(apollo.id, "old news");
    const claire = store.register("Claire");
    expect(store.poll(claire.id)).toEqual([]);
  });

  test("unregister reaps pending directs", () => {
    const temp = store.register("Temp");
    store.send(apollo.id, temp.id, "for-temp");
    expect(store.poll(temp.id, 0).map((m) => m.body)).toContain("for-temp");
    expect(store.unregister(temp.id)).toBe(true);
    // directs to the dead agent are gone; shared broadcasts stay
    expect(store.poll(temp.id, 0).filter((m) => m.to_id === temp.id)).toEqual([]);
    expect(store.listAgents().map((a) => a.id)).not.toContain(temp.id);
  });

  test("wait times out empty", async () => {
    expect(await store.wait(apollo.id, 999, 500)).toEqual([]);
  });

  test("quiet log hides from default poll, shows with flag", () => {
    const before = store.poll(astra.id, 0, true).at(-1)?.seq ?? 0;
    store.log(apollo.id, "status: deploying");
    expect(store.poll(astra.id)).toEqual([]);
    expect(store.poll(astra.id, before, true).map((m) => m.body)).toContain("status: deploying");
  });

  test("targeted quiet log reaches only its peer", () => {
    const bob = store.register("BobQ");
    store.log(apollo.id, "fyi bob", bob.id);
    expect(store.poll(bob.id, store.cursor(bob.id), true).map((m) => m.body)).toContain("fyi bob");
    expect(store.poll(astra.id, 0, true).filter((m) => m.body === "fyi bob")).toEqual([]);
  });

  test("wait sleeps through quiet, resolves on real mail", async () => {
    const bob = store.register("BobW");
    const after = store.cursor(bob.id);
    setTimeout(() => store.log(apollo.id, "noise"), 100);
    setTimeout(() => store.send(apollo.id, bob.id, "signal"), 300);
    const got = await store.wait(bob.id, after, 5000);
    expect(got.map((m) => m.body)).toEqual(["signal"]);
  });

  // Last: wipes the shared store, so nothing after this may use prior agents.
  test("reset wipes agents, messages, and cursors", () => {
    const temp = store.register("Gone");
    store.send(apollo.id, temp.id, "last words");
    store.broadcast(temp.id, "bye all");
    const wiped = store.reset();
    expect(wiped.agents).toBeGreaterThan(0);
    expect(wiped.messages).toBeGreaterThan(0);
    expect(store.listAgents()).toEqual([]);
    expect(store.poll(apollo.id, 0)).toEqual([]);
    expect(store.poll(apollo.id, 0, true)).toEqual([]);
  });
});
