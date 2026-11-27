import { vi } from 'vitest';

/**
 * A fake `ClassmojiService.audit.record` for a test that fakes `audit.create`:
 * the REAL record rule (one retry after a database error, then one
 * `audit_miss` line and `{ written: false }`; an input refusal rethrown outside
 * production) run over the test's own `create` fake, so a test that makes
 * `create` reject sees exactly what production does.
 *
 *   audit: {
 *     create: (...a: unknown[]) => mocks.auditCreate(...a),
 *     record: recordThrough(row => mocks.auditCreate(row)),
 *   },
 *
 * Inside a `vi.mock` factory, load it lazily (the factory is hoisted):
 *   record: (row: unknown) =>
 *     import('<path>/auditRecord.ts').then(m => m.recordThrough(r => mocks.auditCreate(r))(row)),
 */
export function recordThrough(create: (row: never) => unknown) {
  return async (row: unknown) => {
    const { recordWith } = await vi.importActual<typeof import('@classmoji/services/audit')>(
      '@classmoji/services/audit'
    );
    return recordWith(async r => create(r as never), row);
  };
}
