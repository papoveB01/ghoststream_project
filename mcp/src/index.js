#!/usr/bin/env node
// mcp/src/index.js
// ---------------------------------------------------------------------------
// Entry point for the GhostStream MCP server. Speaks the Model Context
// Protocol over stdio to whatever spawned this process (typically Lili).
// Tools talk to the GhostStream API via apiClient.js using the user's
// bearer PAT — see docs/rfcs/0001-lili-integration.md.
//
// Environment contract (all from the spawning client):
//   GHOSTSTREAM_API_URL    required  e.g. https://api.ghoststream.example
//   GHOSTSTREAM_API_TOKEN  required  gs_pat_v1_<8>_<32> bearer PAT
//   GHOSTSTREAM_TIMEOUT_MS optional  default 15000
//
// Missing required vars → clear error to stderr + non-zero exit so the
// MCP client surfaces "preset unavailable" rather than connecting to a
// broken server.
// ---------------------------------------------------------------------------

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const kbSearch = require("./tools/kb_search");

function readContext() {
  const apiUrl = process.env.GHOSTSTREAM_API_URL;
  const token = process.env.GHOSTSTREAM_API_TOKEN;
  const timeoutMs = Number(process.env.GHOSTSTREAM_TIMEOUT_MS) || 15000;

  const missing = [];
  if (!apiUrl) missing.push("GHOSTSTREAM_API_URL");
  if (!token) missing.push("GHOSTSTREAM_API_TOKEN");
  if (missing.length > 0) {
    process.stderr.write(
      `[ghoststream-mcp] missing required env: ${missing.join(", ")}\n`,
    );
    process.exit(2);
  }

  return { apiUrl, token, timeoutMs };
}

async function main() {
  const ctx = readContext();

  const server = new Server(
    { name: "ghoststream", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Tool registry. Add new tools by pushing { schema, handler } here.
  const tools = [kbSearch];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.SCHEMA),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.SCHEMA.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      return await tool.handler(req.params.arguments || {}, ctx);
    } catch (err) {
      process.stderr.write(
        `[ghoststream-mcp] tool ${req.params.name} threw: ${err.stack || err.message}\n`,
      );
      return {
        isError: true,
        content: [{ type: "text", text: `tool ${req.params.name} crashed: ${err.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[ghoststream-mcp] ready — api=${ctx.apiUrl} timeout=${ctx.timeoutMs}ms tools=${tools.length}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[ghoststream-mcp] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
