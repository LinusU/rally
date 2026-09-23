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
});
