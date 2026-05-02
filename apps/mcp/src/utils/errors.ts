import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

/**
 * Throw an MCP-protocol error from a tool/resource handler.
 *
 * The SDK serializes these into JSON-RPC error responses with the right
 * code (per spec). Use ErrorCode.InvalidParams for bad arguments, InternalError
 * for unexpected failures, InvalidRequest for permission/state errors.
 *
 * Note: HTTP-level auth failures (missing/expired bearer) are handled by
 * `requireValidJwt` middleware which returns 401 with WWW-Authenticate.
 * Tool handlers throw McpError for everything that survives auth.
 */
export const mcpError = (
  message: string,
  code: ErrorCode = ErrorCode.InvalidRequest,
  data?: unknown
): McpError => new McpError(code, message, data);

export { ErrorCode };
