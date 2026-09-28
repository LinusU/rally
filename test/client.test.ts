import { SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createProject } from "./helpers";

/** Drives the Worker with the official v2 client, which speaks the newest protocol revision. */
describe("official MCP client", () => {
	it("connects, lists tools and calls one", async () => {
		const p = await createProject("client");
		const transport = new StreamableHTTPClientTransport(new URL("https://rally.test/mcp"), {
			fetch: (input, init) => SELF.fetch(input, init),
			requestInit: { headers: { authorization: `Bearer ${p.agentA}` } },
		});
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await client.connect(transport);

		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toContain("request_work");

		await client.callTool({ name: "create_tasks", arguments: { tasks: [{ title: "Hello" }] } });
		const work = await client.callTool({ name: "request_work", arguments: {} });
		expect(work.isError).toBeFalsy();
		const structured = work.structuredContent as { type: string; task: { title: string } };
		expect(structured).toMatchObject({ type: "implement", task: { title: "Hello" } });

		await client.close();
	});

	it("declines to open a standalone SSE stream", async () => {
		const p = await createProject("client-get");
		const res = await SELF.fetch("https://rally.test/mcp", {
			headers: {
				accept: "text/event-stream",
				authorization: `Bearer ${p.agentA}`,
				"mcp-protocol-version": "2025-11-25",
			},
		});
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("POST");
	});
});
