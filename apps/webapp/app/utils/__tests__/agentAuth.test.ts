/**
 * Unit tests for `stripAuthFromPayload` (agentAuth.server.ts).
 *
 * This helper exists for exactly one reason: a call site that wants to log a
 * webapp -> ai-agent payload calls it first and then believes the result is
 * safe. That belief is the whole security value, so the tests below are written
 * against the PROMISE ("nothing secret survives"), not against the
 * implementation ("`_auth` is destructured off").
 *
 * WHAT WENT WRONG. The helper stripped `_auth` and nothing else. Since the agent
 * consolidation, every syllabus-bot payload also carries `mcpToken`
 * (apps/webapp/app/routes/api.syllabus-bot.$class/route.ts) — a live one-hour
 * bearer for the caller's entire MCP read surface. A payload run through
 * `stripAuthFromPayload` came out still holding it, and came out labelled safe.
 *
 * Note `signPayload` is exercised here only as the producer of a realistic
 * payload; its own signing behaviour is not what these tests are about.
 */

import { describe, expect, it } from 'vitest';

import { stripAuthFromPayload } from '../agentAuth.server';

/** A syllabus-bot payload shaped like the real one the route builds. */
const realisticPayload = () => ({
  userId: 'user-1',
  orgConfig: { orgId: 'class-1', classroomSlug: 'cs52', userRole: 'STUDENT' },
  llmConfig: { anthropicApiKey: 'sk-ant-not-a-real-key', model: 'claude-opus-5' },
  mcpToken: {
    accessToken: 'askmoji_LIVE_BEARER_VALUE',
    expiresAt: '2026-09-10T23:00:00.000Z',
  },
  _auth: { timestamp: 1_757_000_000_000, signature: 'deadbeef'.repeat(8) },
});

describe('stripAuthFromPayload', () => {
  // MUTATION: revert to `const { _auth, ...rest } = payload` → fails.
  it('strips the MCP bearer, not just the HMAC metadata', () => {
    const safe = stripAuthFromPayload(realisticPayload()) as Record<string, unknown>;

    expect(safe).not.toHaveProperty('mcpToken');
    expect(safe).not.toHaveProperty('_auth');
  });

  // The assertion that actually matters: no serialization of the result may
  // contain the bearer, however the field is nested or renamed later.
  it('leaves no trace of the access token anywhere in the serialized result', () => {
    const payload = realisticPayload();
    const serialized = JSON.stringify(stripAuthFromPayload(payload));

    expect(serialized).not.toContain('askmoji_LIVE_BEARER_VALUE');
    expect(serialized).not.toContain(payload._auth.signature);
  });

  it('keeps everything a log line is actually for', () => {
    const safe = stripAuthFromPayload(realisticPayload()) as Record<string, unknown>;

    expect(safe.userId).toBe('user-1');
    expect(safe.orgConfig).toEqual({
      orgId: 'class-1',
      classroomSlug: 'cs52',
      userRole: 'STUDENT',
    });
  });

  it('does not mutate the payload it was handed — the caller still has to send it', () => {
    const payload = realisticPayload();
    stripAuthFromPayload(payload);

    expect(payload.mcpToken.accessToken).toBe('askmoji_LIVE_BEARER_VALUE');
    expect(payload._auth).toBeTruthy();
  });

  it('handles a payload that carries neither field', () => {
    const safe = stripAuthFromPayload({ conversationId: 'c-1', content: 'hello' });
    expect(safe).toEqual({ conversationId: 'c-1', content: 'hello' });
  });

  it('passes null and undefined straight through, as it always has', () => {
    expect(stripAuthFromPayload(null)).toBeNull();
    expect(stripAuthFromPayload(undefined)).toBeUndefined();
  });

  it('strips mcpToken even when it is the only sensitive field present', () => {
    // The sendMessage payload shape: no `_auth` yet, because signing happens
    // later in aiAgentConnection.server.ts.
    const safe = stripAuthFromPayload({
      conversationId: 'c-1',
      content: 'what is due this week?',
      mcpToken: { accessToken: 'askmoji_ANOTHER_BEARER', expiresAt: 'x' },
    }) as Record<string, unknown>;

    expect(safe).not.toHaveProperty('mcpToken');
    expect(JSON.stringify(safe)).not.toContain('askmoji_ANOTHER_BEARER');
    expect(safe.content).toBe('what is due this week?');
  });
});
