import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { TEST_USERS } from './auth.helpers';
import { TestRole } from './env.helpers';

/**
 * Storage-state cache validation for the Playwright auth setup.
 *
 * Extracted from auth.setup.ts so the cache-invalidation rules (TTL + identity
 * fingerprint) can be unit-tested without spinning up a browser. auth.setup.ts
 * imports these — there is no behavioral duplication.
 */

// Cache validity duration (1 hour)
export const CACHE_VALIDITY_MS = 60 * 60 * 1000;

/**
 * Fingerprint that ties a cached storage state to the identity it was created
 * for. If the role's token or configured user changes between runs, the old
 * cached cookie belongs to a DIFFERENT user and MUST NOT be reused — otherwise a
 * stale owner cookie can silently masquerade as the assistant/student and make
 * role-gating assertions pass against the wrong identity.
 */
export function identityFingerprint(role: TestRole): string {
  const u = TEST_USERS[role];
  return createHash('sha256').update(`${u.id}:${u.login}:${u.token}`).digest('hex');
}

export function fingerprintFile(stateFile: string): string {
  return `${stateFile}.fingerprint`;
}

/**
 * Check if a storage state file is valid: exists, recent, has real auth, AND was
 * created for the SAME identity (token+user) we're about to use.
 */
export function isStorageStateValid(stateFile: string, role: TestRole): boolean {
  if (!existsSync(stateFile)) {
    return false;
  }

  try {
    const stats = statSync(stateFile);
    const ageMs = Date.now() - stats.mtimeMs;

    // Check if file is recent enough
    if (ageMs >= CACHE_VALIDITY_MS) {
      return false;
    }

    // Invalidate the cache when the identity changed (token/user rotated).
    const fpFile = fingerprintFile(stateFile);
    if (!existsSync(fpFile) || readFileSync(fpFile, 'utf-8') !== identityFingerprint(role)) {
      return false;
    }

    // Check if file has valid content (not a failure marker)
    const content = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(content);

    // Reject if this is a failed auth marker
    if (parsed._authFailed) {
      return false;
    }

    // Valid storage state has cookies array with at least one cookie
    return Array.isArray(parsed.cookies) && parsed.cookies.length > 0;
  } catch {
    return false;
  }
}
