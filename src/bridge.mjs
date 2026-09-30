import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "tokenpilot", version: "1.0.0" });
const definitions = {
  discover: {
    description:
      "List relevant project files. Use a narrow path prefix. Generated files are excluded.",
    schema: { prefix: z.string().default("") },
  },
  search: {
    description:
      "Literal text search within a path prefix. Returns bounded matching lines.",
    schema: { text: z.string().min(1), prefix: z.string().default("") },
  },
  read: {
    description:
      "Read a bounded section of a text file. Unchanged duplicate reads return a reference.",
    schema: {
      path: z.string(),
      start: z.number().int().min(1).default(1),
      lines: z.number().int().min(1).max(400).default(120),
    },
  },
  edit: {
    description:
      "Replace one exact unique text fragment in a file. Read the relevant section first.",
    schema: {
      path: z.string(),
      old: z.string().min(1),
      replacement: z.string(),
    },
  },
  write: {
    description: "Create a new text file. Existing files must use edit.",
    schema: { path: z.string(), content: z.string() },
  },
  verify: {
    description:
      "Run selected project verification. Omit id to run required and relevant checks. No check is reported passed unless executed successfully.",
    schema: { id: z.string().optional() },
  },
  command: {
    description:
      "Request a command that cannot be performed with other tools. User approval is required. Provide a concrete reason or new debugging hypothesis.",
    schema: { command: z.array(z.string()).min(1), reason: z.string().min(8) },
  },
  escalate: {
    description:
      "Request a fresh higher-effort session. Include evidence and unresolved work. Ends current session if accepted.",
    schema: { reason: z.string().min(10), handoff: z.string().min(10) },
  },
  finish: {
    description:
      "Complete only when each acceptance criterion is satisfied. Runs required checks and blocks if they fail. Provide an honest summary of evidence.",
    schema: {
      summary: z.string().min(1),
      acceptance: z
        .array(
          z.object({
            criterion: z.string(),
            satisfied: z.boolean(),
            evidence: z.string(),
          }),
        )
        .min(1),
    },
  },
};
for (const [name, d] of Object.entries(definitions))
  server.registerTool(
    name,
    { description: d.description, inputSchema: d.schema },
    async (args) => {
      try {
        const response = await fetch(process.env.TOKENPILOT_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${process.env.TOKENPILOT_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name, args }),
        });
        const result = await response.json();
        return {
          isError: !response.ok,
          content: [
            {
              type: "text",
              text:
                typeof result === "string" ? result : JSON.stringify(result),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    },
  );
await server.connect(new StdioServerTransport());
