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
export function signPayload(payload) {
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
 * Remove auth metadata from payload (for safe logging)
 *
 * @param {Object} payload - Payload with potential _auth field
 * @returns {Object} - Payload without _auth
 */
export function stripAuthFromPayload(payload) {
  if (!payload) return payload;
  // eslint-disable-next-line no-unused-vars
  const { _auth, ...rest } = payload;
  return rest;
}
