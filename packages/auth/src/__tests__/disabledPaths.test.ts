/**
 * Paths better-auth's HTTP router answers 404 for (`disabledPaths` in
 * server.ts), through the same `auth.handler` every app mounts.
 */

import { describe, expect, it, vi } from 'vitest';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const mocks = vi.hoisted(() => {
  const client: Record<string, Record<string, unknown>> = {};
  for (const model of [
    'user',
    'session',
    'account',
    'verification',
    'oauthAccessToken',
    'oauthApplication',
    'oauthConsent',
  ]) {
    client[model] = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findUnique: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: { data: unknown }) => Promise.resolve(data)),
      update: vi.fn(({ data }: { data: unknown }) => Promise.resolve(data)),
      delete: vi.fn(() => Promise.resolve({})),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      count: vi.fn(() => Promise.resolve(0)),
    };
  }
  return { client };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

const { auth } = await import('../server.ts');

const BASE = 'http://localhost:3000/api/auth';

describe('disabled better-auth paths', () => {
  it('answers /list-sessions with 404', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/list-sessions`, { headers: { cookie: 'classmoji.session_token=x' } })
    );
    expect(res.status).toBe(404);
  });

  it('still serves /get-session', async () => {
    const res = await auth.handler(new Request(`${BASE}/get-session`));
    expect(res.status).toBe(200);
  });
});
