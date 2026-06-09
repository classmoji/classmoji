import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// auth.helpers.ts (pulled in transitively) resolves role tokens at import time
// and throws if they're unset. In the e2e run these come from .env; for this
// bare unit run, provide deterministic dummies BEFORE the static imports
// evaluate (vi.hoisted runs first). identityFingerprint only hashes them.
vi.hoisted(() => {
  process.env.GITHUB_PROF_TOKEN ||= 'unit-prof-token';
  process.env.GITHUB_TA_TOKEN ||= 'unit-ta-token';
  process.env.GITHUB_STUDENT_TOKEN ||= 'unit-student-token';
});

import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  identityFingerprint,
  fingerprintFile,
  isStorageStateValid,
  CACHE_VALIDITY_MS,
} from '../../tests/helpers/authCache.helpers';

/**
 * Unit coverage for the Playwright auth-cache validation. The e2e setup writes a
 * storage-state file plus an identity fingerprint; isStorageStateValid must
 * reuse a cached session ONLY when it is fresh AND was created for the same
 * identity. The critical security property: a token/user ROTATION must
 * invalidate the cache so a stale owner cookie can't masquerade as another role.
 */
describe('isStorageStateValid', () => {
  const ROLE = 'owner' as const;
  let dir: string;
  let stateFile: string;

  const writeState = (cookies: unknown[], extra: Record<string, unknown> = {}) =>
    writeFileSync(stateFile, JSON.stringify({ cookies, origins: [], ...extra }));
  const writeFingerprint = (value: string) => writeFileSync(fingerprintFile(stateFile), value);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-authcache-'));
    stateFile = join(dir, 'owner.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is false when the state file does not exist', () => {
    expect(isStorageStateValid(stateFile, ROLE)).toBe(false);
  });

  it('is true for a fresh state with cookies and a matching fingerprint', () => {
    writeState([{ name: 'classmoji.session_token', value: 'abc' }]);
    writeFingerprint(identityFingerprint(ROLE));
    expect(isStorageStateValid(stateFile, ROLE)).toBe(true);
  });

  it('INVALIDATES the cache when the identity fingerprint rotated', () => {
    writeState([{ name: 'classmoji.session_token', value: 'abc' }]);
    // Simulate a token/user rotation: the persisted fingerprint no longer
    // matches the current identity.
    writeFingerprint(`${identityFingerprint(ROLE)}-stale-rotated`);
    expect(isStorageStateValid(stateFile, ROLE)).toBe(false);
  });

  it('is false when the fingerprint sidecar is missing entirely', () => {
    writeState([{ name: 'classmoji.session_token', value: 'abc' }]);
    expect(isStorageStateValid(stateFile, ROLE)).toBe(false);
  });

  it('is false for a failed-auth marker even with a matching fingerprint', () => {
    writeState([], { _authFailed: true });
    writeFingerprint(identityFingerprint(ROLE));
    expect(isStorageStateValid(stateFile, ROLE)).toBe(false);
  });

  it('is false when the cookies array is empty', () => {
    writeState([]);
    writeFingerprint(identityFingerprint(ROLE));
    expect(isStorageStateValid(stateFile, ROLE)).toBe(false);
  });

  it('is false once the state file is older than the TTL', () => {
    writeState([{ name: 'classmoji.session_token', value: 'abc' }]);
    writeFingerprint(identityFingerprint(ROLE));
    // Backdate mtime beyond the cache validity window.
    const stale = (Date.now() - CACHE_VALIDITY_MS - 60_000) / 1000;
    utimesSync(stateFile, stale, stale);
    expect(isStorageStateValid(stateFile, ROLE)).toBe(false);
  });
});
