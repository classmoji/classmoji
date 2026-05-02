/**
 * Internal helper to register a "not yet implemented" tool. Lets us ship the
 * MCP server skeleton and verify auth + tool-listing while individual tools
 * are filled in across Phase 3 batches.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth/context.ts';
import { ErrorCode, mcpError } from '../utils/errors.ts';

export function registerStubTool(
  server: McpServer,
  name: string,
  description: string,
  _ctx: AuthContext
): void {
  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema: z.object({}).passthrough().shape,
    },
    async () => {
      throw mcpError(
        `${name} is not yet implemented (Phase 3 work in progress)`,
        ErrorCode.InternalError
      );
    }
  );
}
