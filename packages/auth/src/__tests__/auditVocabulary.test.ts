/**
 * The gates name a refusal's resource in the audit vocabulary: a caller's
 * `resourceType` is an `AuditResourceType`, so a gate cannot be handed a name
 * the audit log does not know. Type-level only (checked by `tsc`).
 */
import { describe, expectTypeOf, it } from 'vitest';
import type { AuditResourceType } from '@classmoji/services/audit';

import type {
  assertClassroomAccess,
  requireClassroomAdmin,
  requireClassroomStaff,
  requireClassroomTeachingTeam,
  requireStudentAccess,
} from '../server.ts';

type GateOption<F extends (...args: never[]) => unknown> = NonNullable<
  NonNullable<Parameters<F>[2]>['resourceType']
>;

describe('the gates’ resource types', () => {
  it('are the audit vocabulary', () => {
    expectTypeOf<
      NonNullable<Parameters<typeof assertClassroomAccess>[0]['resourceType']>
    >().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<GateOption<typeof requireClassroomAdmin>>().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<GateOption<typeof requireClassroomStaff>>().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<
      GateOption<typeof requireClassroomTeachingTeam>
    >().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<GateOption<typeof requireStudentAccess>>().toEqualTypeOf<AuditResourceType>();
  });
});
