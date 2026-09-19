/**
 * Service-to-service authentication for webapp → ai-agent communication
 *
 * SECURITY:
 * - Uses HMAC-SHA256 for message signing
 * - Timestamp prevents replay attacks (30 second window)
 * - Shared secret must be set in AI_AGENT_SHARED_SECRET env var
 *
 * Usage:
 * ```javascript
 * import { signPayload, stripAuthFromPayload } from '~/utils/agentAuth.server';
 *
 * // Sign before sending to ai-agent
 * const signedPayload = signPayload({ sessionId, message });
 *
 * // Strip auth metadata when logging (avoid leaking signatures)
 * const safeToLog = stripAuthFromPayload(signedPayload);
 * ```
 */

import crypto from 'crypto';

const SECRET = process.env.AI_AGENT_SHARED_SECRET;

/**
 * Sign a payload for ai-agent authentication
 * Timestamp prevents replay attacks (30 second window)
 *
 * @param {Object} payload - The payload to sign
 * @returns {Object} - Payload with _auth metadata attached
 * @throws {Error} - If AI_AGENT_SHARED_SECRET is not configured
 */
export function signPayload(payload: Record<string, unknown>) {
  if (!SECRET) {
    console.warn('[agentAuth] AI_AGENT_SHARED_SECRET not configured, skipping signature');
    // Return payload without signing in development (graceful degradation)
    // In production, this should be treated as an error
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AI_AGENT_SHARED_SECRET is required in production');
    }
    return payload;
  }

  const timestamp = Date.now();
  const data = JSON.stringify(payload);

  const signature = crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}.${data}`)
    .digest('hex');

  return {
    ...payload,
    _auth: { timestamp, signature },
  };
}

/**
 * Every payload field that must never reach a log line. Kept as one list so the
 * next credential added to a webapp -> ai-agent payload has an obvious place to
 * be declared, instead of being remembered at each call site.
 *
 *  - `_auth`     the HMAC signature and timestamp this module attaches.
 *  - `mcpToken`  the per-turn MCP bearer minted by `mintMcpAccessToken`
 *                (packages/auth/src/mcpToken.ts) and carried on every syllabus-bot
 *                payload. `{ accessToken, expiresAt }` — `accessToken` is a live
 *                bearer for the caller's whole MCP read surface for the next hour.
 *                Stripping only `_auth` left it in: the helper's entire promise is
 *                "safe to log", so a payload that still carries a working
 *                credential after passing through here is worse than no helper at
 *                all, because the call site believes it is sanitized.
 */
const SENSITIVE_PAYLOAD_FIELDS = ['_auth', 'mcpToken'] as const;

/**
 * Remove auth metadata and credentials from a payload, for safe logging.
 *
 * Drops the whole field rather than redacting inside it: an `mcpToken` gains a
 * field one day and a redactor that walked its keys would quietly start passing
 * the new one through.
 *
 * @param {Object} payload - Payload with potential `_auth` / `mcpToken` fields
 * @returns {Object} - Payload with every field in SENSITIVE_PAYLOAD_FIELDS removed
 */
export function stripAuthFromPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) return payload;

  const rest: Record<string, unknown> = { ...payload };
  for (const field of SENSITIVE_PAYLOAD_FIELDS) delete rest[field];
  return rest;
}
