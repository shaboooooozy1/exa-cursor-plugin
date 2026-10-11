#!/usr/bin/env node
/**
 * Local (stdio) MCP server for the Exa search API.
 *
 * Tools: exa_search (web search), exa_get_contents (read pages), exa_answer (cited answers).
 * Requires EXA_API_KEY in the environment. All logging goes to stderr; stdout carries the protocol.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EXA_BASE_URL, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerAnswerTool } from "./tools/answer.js";
import { registerContentsTool } from "./tools/contents.js";
import { registerSearchTool } from "./tools/search.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerSearchTool(server);
  registerContentsTool(server);
  registerAnswerTool(server);
  return server;
}

async function main(): Promise<void> {
  // Start even without a key: exiting here would show the user only "server disconnected",
  // whereas a running server returns the setup instructions on the first tool call.
  if (!process.env.EXA_API_KEY?.trim()) {
    console.error(
      "WARNING: EXA_API_KEY is not set; tool calls will return setup instructions until it is added. Get a key at https://dashboard.exa.ai/api-keys",
    );
  }

  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio (Exa API: ${EXA_BASE_URL})`);
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
