/**
 * Typed errors for the MCP server.
 *
 * Two families:
 * - `UnauthorizedError` — HTTP-level: the bearer token is missing/invalid/expired.
 *   The HTTP layer converts it to a 401 with a WWW-Authenticate challenge
 *   pointing at our protected-resource metadata (RFC 9728).
 * - `ToolError` — tool-call-level: authorization, validation, and rate-limit
 *   failures inside a tool/resource handler. The registry's error wrapper (S5)
 *   converts these to structured `isError` tool results so a thrown error can
 *   never hang the request or crash the process.
 */

export type ToolErrorKind =
  | 'invalid_params'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'internal';

export class ToolError extends Error {
  kind: ToolErrorKind;
  /** Optional machine-readable code (e.g. CLASSROOM_LOCKED) mirroring the webapp's typed 403s. */
  code?: string;

  constructor(kind: ToolErrorKind, message: string, code?: string) {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.code = code;
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
