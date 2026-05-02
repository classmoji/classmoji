import type { Request, Response } from 'express';

const WEBAPP_URL = process.env.WEBAPP_URL ?? 'http://localhost:3001';
const MCP_AUDIENCE = process.env.MCP_AUDIENCE ?? 'http://localhost:8100/mcp';

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * Tells MCP clients (Claude Desktop, Claude Code, claude.ai) where to find
 * our authorization server. Returned both via this endpoint and (more
 * importantly) via the `WWW-Authenticate` header on 401 responses from /mcp.
 */
export function protectedResourceMetadata(_req: Request, res: Response): void {
  res.json({
    resource: MCP_AUDIENCE,
    authorization_servers: [`${WEBAPP_URL}/api/auth`],
    bearer_methods_supported: ['header'],
    resource_documentation: `${WEBAPP_URL}/docs/mcp`,
  });
}
