import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openStore } from "./store.js";

export async function runServer() {
const dir = join(process.cwd(), ".beamline");
mkdirSync(dir, { recursive: true });
const store = openStore(join(dir, "beamline.db"));

const server = new McpServer({ name: "beamline", version: "0.2.0" });
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

server.registerTool("beamline_register", {
  description: "Join this workspace bus. Returns {id, name}. Save the id — pass it as agent_id/from_id everywhere. If this session is already linked (BEAMLINE_AGENT env or .beamline/sessions/<session-id> exists), reuse that id instead of registering again.",
  inputSchema: { name: z.string().optional().describe("Preferred codename; random one assigned if omitted/taken") },
}, ({ name }) => text(store.register(name)));

server.registerTool("beamline_send", {
  description: "Send a direct message to one agent by id.",
  inputSchema: {
    from_id: z.string(), to_id: z.string(), body: z.string(),
    thread_id: z.string().optional(),
  },
}, ({ from_id, to_id, body, thread_id }) => text(store.send(from_id, to_id, body, thread_id)));

server.registerTool("beamline_broadcast", {
  description: "Send a message to every agent on this workspace bus.",
  inputSchema: { from_id: z.string(), body: z.string(), thread_id: z.string().optional() },
}, ({ from_id, body, thread_id }) => text(store.broadcast(from_id, body, thread_id)));

server.registerTool("beamline_poll", {
  description: "Fetch messages for agent_id after after_seq (defaults to last ack cursor). Does not mark read.",
  inputSchema: { agent_id: z.string(), after_seq: z.number().optional() },
}, ({ agent_id, after_seq }) => text(store.poll(agent_id, after_seq)));

server.registerTool("beamline_wait", {
  description: "Block until a message arrives for agent_id or timeout_ms elapses. End turns with this instead of stopping when expecting mail. Use YOUR linked agent id — never invent one.",
  inputSchema: {
    agent_id: z.string(), after_seq: z.number().optional(),
    timeout_ms: z.number().optional().describe("Max wait, default 30000"),
  },
}, ({ agent_id, after_seq, timeout_ms }) => store.wait(agent_id, after_seq, timeout_ms).then(text));

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
