/**
 * Who a request to the MCP server is: what resolveViewer.ts derives from its
 * bearer token, plus the request hints routes/mcp.ts adds.
 */

import type { Role } from '@prisma/client';

export type Scope = 'read' | 'write';

/**
 * What kind of token the request carried:
 *   - `jwt`: an access token the OAuth server (better-auth, the webapp)
 *     signed for an MCP client the user connected (auth/jwtAccessToken.ts);
 *   - `internal`: a token Classmoji minted itself, for Ask Moji's and the
 *     quiz agent's turns or the dev mint (auth/internalToken.ts).
 */
export type TokenKind = 'jwt' | 'internal';

export interface Viewer {
  userId: string;
  /** The client the token was issued to: the JWT's `azp`, or the internal row's client id. */
  clientId: string | null;
  /**
   * Set by resolveViewer on every viewer it returns. Only `internal` lets
   * routes/mcp.ts read Ask Moji's role ceiling and View as headers; a viewer
   * without it (one a test builds by hand) is treated as not internal.
   */
  tokenKind?: TokenKind;
  /** Granted scopes: the JWT's `scope` claim, or the internal row's scopes. */
  scopes: ReadonlySet<string>;
  /**
   * A caller-supplied IANA zone (the `X-Classmoji-Timezone` header), already
   * validated against Intl; null/absent when none was sent or it was invalid.
   * A RENDERING hint only — it never reaches an authorization decision. Used
   * for `_local` fields when the classroom has no zone of its own (Ask Moji
   * passes the student's browser zone; the Claude.ai connector sends none).
   */
  timezoneHint?: string | null;
  /**
   * The MCP session this request belongs to (`Mcp-Session-Id`, issued on
   * initialize; see routes/mcp.ts), when the client sent a well-formed one.
   * Only tells a person's agent sessions apart in live editing — never part
   * of an authorization decision.
   */
  agentSession?: string | null;
  /**
   * The highest role this request may resolve as in any classroom (the
   * `X-Classmoji-Role-Ceiling` header, see routes/mcp.ts). Set only for an
   * internal Ask Moji token, which sends the view the chat was opened in;
   * null for every other token, whatever it sends. Narrows tool and resource
   * role resolution (authz/classroomContext.ts) and nothing else.
   */
  roleCeiling?: Role | null;
  /**
   * The platform admin viewing as this user, when an Ask Moji turn runs under
   * View as: the admin the internal token's row names (the mint read it from
   * the View as session). Null for every other token. Recorded as
   * `impersonated_by` on every audit row the request writes (mcp/audit.ts)
   * and nothing else.
   */
  impersonatedBy?: string | null;
}

/** Whether a user row is banned now: `banned`, with no end date or one still ahead. */
export function isBanned(
  user: { banned: boolean; ban_expires_at: Date | null } | null | undefined,
  now: number
): boolean {
  if (!user?.banned) return false;
  return !user.ban_expires_at || user.ban_expires_at.getTime() > now;
}
