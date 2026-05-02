import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from './auth/context.ts';
import { registerTools } from './tools/index.ts';
import { registerResources } from './resources/index.ts';

/**
 * Per-session McpServer factory.
 *
 * Builds a fresh McpServer for each Streamable HTTP session, with tool and
 * resource registration filtered by the user's roles AND the token's scopes.
 * The user's authentication context is captured in closures inside each
 * handler — no need to thread `ctx` through tool calls.
 *
 * Roles + scopes are fixed for the session lifetime; if they change (role
 * promotion, scope expansion via re-auth), the user must reconnect.
 */
export function buildServerForUser(ctx: AuthContext): McpServer {
  const server = new McpServer(
    { name: 'classmoji', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  return server;
}
