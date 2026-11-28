/**
 * For a test that fakes `@classmoji/services`.
 *
 * `@classmoji/auth/server` (and the admin routes) import the services they
 * call from their own subpaths (`@classmoji/services/<name>`), not through the
 * ClassmojiService object. Mock each such subpath with this, so the code under
 * test gets the same member of the test's ClassmojiService fake it got when it
 * read the object; a member the fake does not have becomes an empty module,
 * as an absent member was before:
 *
 *   const { fromServicesFake } = await vi.hoisted(() => import('./support/servicesFake.ts'));
 *   vi.mock('@classmoji/services/audit', () => fromServicesFake('audit'));
 *
 * Only for tests whose `@classmoji/services` fake builds its object without
 * the real module (no `importOriginal`): the subpath and the real package
 * import the same files.
 */

import { vi } from 'vitest';
export async function fromServicesFake(name: string): Promise<object> {
  const root = (await import('@classmoji/services')) as {
    ClassmojiService?: Record<string, unknown>;
  };
  let service: unknown;
  try {
    service = root.ClassmojiService?.[name];
  } catch {
    // A fake without a ClassmojiService export.
    service = undefined;
  }
  const fake = (service as object | undefined) ?? {};
  if (name === 'audit' && !('withImpersonator' in fake)) {
    // A pure helper the gates build rows with, not a write: the real one.
    const { withImpersonator } = await vi.importActual<typeof import('@classmoji/services/audit')>(
      '@classmoji/services/audit'
    );
    return { ...fake, withImpersonator };
  }
  return fake;
}
