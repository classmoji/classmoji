/**
 * For a test that fakes `@classmoji/services`.
 *
 * The admin routes import the services they call from their own subpaths
 * (`@classmoji/services/<name>`), not through the ClassmojiService object.
 * Mock each such subpath with this, so the route gets the same member of the
 * test's ClassmojiService fake; a member the fake does not have becomes an
 * empty module:
 *
 *   const { fromServicesFake } = await vi.hoisted(
 *     () => import('~/__tests__/support/servicesFake.ts')
 *   );
 *   vi.mock('@classmoji/services/feedback', () => fromServicesFake('feedback'));
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
