/**
 * Every MCP audit row is named in the audit vocabulary: a tool's
 * `writeAudit`/`writeAuditOrFail` entry and a read's `auditRead` declaration
 * take an `AuditResourceType`. Type-level (checked by `tsc`), plus the names
 * tag rows and team rows now carry.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AuditResourceType } from '@classmoji/services/audit';
import { isAuditResourceType } from '@classmoji/services/audit-resource-types';

import type { AuditEntry, ReadAudit } from '../audit.ts';

describe('the MCP audit vocabulary', () => {
  it('types every row the tools and reads write', () => {
    expectTypeOf<AuditEntry['resource_type']>().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<ReadAudit['resourceType']>().toEqualTypeOf<AuditResourceType>();
  });

  it('has a name for tags of their own, apart from teams', () => {
    expect(isAuditResourceType('TAGS')).toBe(true);
    expect(isAuditResourceType('TEAMS')).toBe(true);
  });
});
