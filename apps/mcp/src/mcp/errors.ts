/**
 * Typed errors for the MCP server.
 *
 * Two families:
 * - `UnauthorizedError` — HTTP-level: the bearer token is missing/invalid/expired.
 *   The HTTP layer converts it to a 401 with a WWW-Authenticate challenge
 *   pointing at our protected-resource metadata (RFC 9728).
 *   `TokenStoreUnavailableError` is its sibling for when the token could not be
 *   checked at all (the database is down or its tables are missing): a 503
 *   with Retry-After and NO challenge, so clients try again later instead of
 *   asking the person to sign in again.
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
  /**
   * Optional structured payload merged into the serialized error JSON
   * (e.g. `{ ids: [...] }` from a PreviewResolutionError), so MCP clients get
   * the same machine-readable details the web actions return.
   */
  data?: Record<string, unknown>;

  constructor(kind: ToolErrorKind, message: string, code?: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.code = code;
    this.data = data;
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The token lookup itself failed because the store behind it is unavailable —
 * nothing was learned about the token. See `auth/tokenStoreErrors.ts` for what
 * counts; everything else stays an `UnauthorizedError`.
 */
export class TokenStoreUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Token store unavailable', options);
    this.name = 'TokenStoreUnavailableError';
  }
}

/**
 * The bearer was not found and has the shape of a token this server version
 * does not read (see `isNewerTokenFormat` in auth/resolveViewer.ts): answered
 * like `TokenStoreUnavailableError`, 503 + Retry-After, no challenge.
 */
export class UnsupportedTokenFormatError extends Error {
  constructor() {
    super('Token format not read by this server version');
    this.name = 'UnsupportedTokenFormatError';
  }
}
