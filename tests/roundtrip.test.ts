import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store";

// ponytail: one round-trip file is the whole suite; add cases only when a regression bites.
describe("beamline round-trip", () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), "bl-")), "t.db"));
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

  test("broadcast reaches everyone", () => {
    store.broadcast(apollo.id, "standup");
    expect(store.poll(apollo.id).map((m) => m.body)).toEqual(["standup"]);
  });

  test("ack advances cursor", () => {
    store.ack(astra.id, 99);
    expect(store.poll(astra.id)).toEqual([]);
  });

  test("wait resolves on send", async () => {
    const bob = store.register("Bob");
    const after = store.poll(bob.id).at(-1)?.seq ?? 0; // skip pre-existing broadcasts
    setTimeout(() => store.send(apollo.id, bob.id, "ping"), 300);
    const got = await store.wait(bob.id, after, 5000);
    expect(got.map((m) => m.body)).toEqual(["ping"]);
  });

  test("wait times out empty", async () => {
    expect(await store.wait(apollo.id, 999, 500)).toEqual([]);
  });
});
