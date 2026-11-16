/**
 * For a test that fakes `@classmoji/services` and runs the real
 * `@classmoji/auth/server`.
 *
 * The auth module imports the services it calls from their own subpaths
 * (`@classmoji/services/<name>`), not through the ClassmojiService object.
 * Mock each such subpath with this, so auth gets the same member of the test's
 * ClassmojiService fake it got when it read the object; a member the fake does
 * not have becomes an empty module, as an absent member was before:
 *
 *   const { fromServicesFake } = await vi.hoisted(
 *     () => import('~/__tests__/support/servicesFake.ts')
 *   );
 *   vi.mock('@classmoji/services/audit', () => fromServicesFake('audit'));
 *
 * Only for tests whose `@classmoji/services` fake builds its object without
 * the real module (no `importOriginal`): the subpath and the real package
 * import the same files.
 */
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
  return (service as object | undefined) ?? {};
}
