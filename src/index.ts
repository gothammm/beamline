import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openStore } from "./store.js";
import pkg from "../package.json";

export async function runServer() {
const dir = join(process.cwd(), ".beamline");
mkdirSync(dir, { recursive: true });
const store = openStore(join(dir, "beamline.db"));

const server = new McpServer({ name: "beamline", version: (pkg as { version?: string })?.version ?? "0.0.0" });
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

server.registerTool("beamline_register", {
  description: "Join this workspace bus. Returns {id, name}. Save the id — pass it as agent_id/from_id everywhere. If this session is already linked (BEAMLINE_AGENT env or .beamline/sessions/<session-id> exists), reuse that id instead of registering again.",
  inputSchema: { name: z.string().optional().describe("Preferred codename; random one assigned if omitted/taken") },
}, ({ name }) => text(store.register(name)));

server.registerTool("beamline_send", {
  description: "Send a direct message to one agent by id. Wakes the peer (costs peer tokens) — FYI without reply goes to beamline_log. No auth — workspace-local bus, from_id is asserted not proven.",
  inputSchema: {
    from_id: z.string(), to_id: z.string(), body: z.string(),
    thread_id: z.string().optional(),
  },
}, ({ from_id, to_id, body, thread_id }) => text(store.send(from_id, to_id, body, thread_id)));

server.registerTool("beamline_broadcast", {
  description: "Send a message to every agent on this workspace bus. No auth — workspace-local bus, from_id is asserted not proven.",
  inputSchema: { from_id: z.string(), body: z.string(), thread_id: z.string().optional() },
}, ({ from_id, body, thread_id }) => text(store.broadcast(from_id, body, thread_id)));

server.registerTool("beamline_log", {
  description: "Record a log line without waking anyone. Costs your tokens, not your peer's. Peers read it on explicit poll with include_quiet. Need a reply — use beamline_send.",
  inputSchema: {
    from_id: z.string(), body: z.string(),
    to_id: z.string().optional().describe("One peer's FYI; omit and every agent can read it"),
    thread_id: z.string().optional(),
  },
}, ({ from_id, to_id, body, thread_id }) => text(store.log(from_id, body, to_id, thread_id)));

server.registerTool("beamline_poll", {
  description: "Fetch messages for agent_id after after_seq (defaults to last ack cursor). Does not mark read. Quiet log lines excluded unless include_quiet.",
  inputSchema: { agent_id: z.string(), after_seq: z.number().optional(), include_quiet: z.boolean().optional() },
}, ({ agent_id, after_seq, include_quiet }) => text(store.poll(agent_id, after_seq, include_quiet ?? false)));

server.registerTool("beamline_wait", {
  description: "Block until a message arrives for agent_id or timeout_ms elapses. End turns with this instead of stopping when expecting mail. Use YOUR linked agent id — never invent one.",
  inputSchema: {
    agent_id: z.string(), after_seq: z.number().optional(),
    timeout_ms: z.number().optional().describe("Max wait, default 30000"),
    include_quiet: z.boolean().optional().describe("Also resolve on quiet log lines; default ignores them"),
  },
}, ({ agent_id, after_seq, timeout_ms, include_quiet }) => store.wait(agent_id, after_seq, timeout_ms, include_quiet ?? false).then(text));

server.registerTool("beamline_ack", {
  description: "Advance agent_id's read cursor past upto_seq so poll/wait skip old mail.",
  inputSchema: { agent_id: z.string(), upto_seq: z.number() },
}, ({ agent_id, upto_seq }) => {
  store.ack(agent_id, upto_seq);
  return text({ ok: true });
});

server.registerTool("beamline_list_agents", {
  description: "List all agents registered on this workspace bus.",
  inputSchema: {},
}, () => text(store.listAgents()));

server.registerTool("beamline_unregister", {
  description: "Remove an agent from this workspace bus (session end / stale harness cleanup). Idempotent.",
  inputSchema: { agent_id: z.string() },
}, ({ agent_id }) => text({ ok: true, removed: store.unregister(agent_id) }));

await server.connect(new StdioServerTransport());
}

if (import.meta.main) await runServer();
