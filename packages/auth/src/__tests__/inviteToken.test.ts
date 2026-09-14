import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  signInviteToken,
  verifyInviteToken,
  inviteTokenMatchesEmail,
  INVITE_TOKEN_TTL_MS,
} from '../inviteToken.ts';

const payload = { email: 'Student@School.edu', classroomId: 'class-1' };

afterEach(() => {
  vi.useRealTimers();
});

describe('signInviteToken / verifyInviteToken', () => {
  it('round-trips the address and classroom', () => {
    expect(verifyInviteToken(signInviteToken(payload))).toEqual(payload);
  });

  it('refuses to mint for a malformed address or empty classroom', () => {
    expect(() => signInviteToken({ email: 'nope', classroomId: 'c' })).toThrow();
    expect(() => signInviteToken({ email: 'a@b.co', classroomId: '' })).toThrow();
  });

  it('rejects a tampered payload', () => {
    const token = signInviteToken(payload);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), email: 'x@y.co' })
    ).toString('base64url');
    expect(verifyInviteToken(`${forged}.${mac}`)).toBeNull();
  });

  it('rejects garbage, wrong shapes, and expired tokens with one null', () => {
    expect(verifyInviteToken('')).toBeNull();
    expect(verifyInviteToken('a.b.c')).toBeNull();
    expect(verifyInviteToken(42)).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
    const token = signInviteToken(payload);
    vi.setSystemTime(new Date(Date.now() + INVITE_TOKEN_TTL_MS + 1));
    expect(verifyInviteToken(token)).toBeNull();
  });

  it('matches the invited address case-insensitively and trimmed', () => {
    expect(inviteTokenMatchesEmail(payload, '  student@school.EDU ')).toBe(true);
    expect(inviteTokenMatchesEmail(payload, 'other@school.edu')).toBe(false);
  });
});
