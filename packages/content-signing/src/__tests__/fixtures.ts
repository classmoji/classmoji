import type { SigningContext, Tier } from '../types.ts';

export const MASTER = 'master-secret-for-tests-only';
export const OTHER_MASTER = 'a-different-master-secret';

export const ORIGIN = 'https://cdn.classmoji.test';
export const HOST = 'cdn.classmoji.test';
export const OTHER_ORIGIN = 'https://other.classmoji.test';

export const CLASSROOM_A = '11111111-2222-4333-8444-555555555555';
export const CLASSROOM_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
export const TREE_SHA = '89abcdef0123456789abcdef0123456789abcdef';

/** 2026-01-01T00:00:00Z — every test pins `now` to keep output deterministic. */
export const NOW = 1767225600;

export function ctx(tier: Tier, overrides: Partial<SigningContext> = {}): SigningContext {
  return {
    master: MASTER,
    classroomId: CLASSROOM_A,
    keyVersion: 0,
    tier,
    now: NOW,
    ...overrides,
  };
}

/** Rewrite one query param on an already-signed blob URL. */
export function withParam(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
}

export function withoutParam(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete(name);
  return parsed.toString();
}
