/**
 * Mock MCP Server — lightweight MCP server that exposes configurable tools
 * with canned responses. Used for testing gateway gating without real
 * third-party services.
 *
 * Spawned as a child process via stdio transport, just like real integrations.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface MockTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Parse config from env
const toolsJson = process.env.MOCK_MCP_TOOLS ?? '[]';
const serverName = process.env.MOCK_MCP_NAME ?? 'mock';

const tools: MockTool[] = JSON.parse(toolsJson);

const server = new Server(
  { name: serverName, version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  // Return the arguments back as a JSON response (useful for verifying what was passed)
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ tool: toolName, args, success: true }, null, 2),
    }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
