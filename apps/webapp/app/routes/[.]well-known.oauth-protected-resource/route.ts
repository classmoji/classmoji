import type { LoaderFunctionArgs } from 'react-router';

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata
 *
 * Tells MCP clients (Claude Desktop, Claude Code, claude.ai) where to find
 * our authorization server. The MCP server at mcp.classmoji.io serves an
 * equivalent endpoint pointing at the same AS; this one is for the webapp's
 * own protected APIs (currently only the auth surface itself).
 *
 * The MCP server's resource metadata lives in apps/mcp/src/resourceMetadata.ts.
 */
export function loader(_: LoaderFunctionArgs) {
  const webappUrl = process.env.WEBAPP_URL ?? 'https://classmoji.io';
  return Response.json({
    resource: webappUrl,
    authorization_servers: [`${webappUrl}/api/auth`],
    bearer_methods_supported: ['header'],
    resource_documentation: `${webappUrl}/docs/oauth`,
  });
}
