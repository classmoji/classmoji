/**
 * The audit vocabulary: one list of the names written, the names retired from
 * it, and the helpers readers use so an old row and a new one about the same
 * thing are found and printed alike. That every writer takes the list is a
 * compile-time fact (the service's and each funnel's `resource_type` is
 * `AuditResourceType`); the type assertions below pin it for the service.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AuditLogData } from '../audit.service.ts';
import * as auditService from '../audit.service.ts';
import {
  AUDIT_RESOURCE_TYPES,
  RETIRED_AUDIT_RESOURCE_TYPES,
  auditResourceLabel,
  auditResourceTypeNames,
  currentAuditResourceType,
  isAuditResourceType,
  type AuditResourceType,
} from '../auditResourceTypes.ts';

describe('the audit resource vocabulary', () => {
  it('lists each name once', () => {
    expect(new Set(AUDIT_RESOURCE_TYPES).size).toBe(AUDIT_RESOURCE_TYPES.length);
  });

  it('retires names to names still written, and writes no retired name', () => {
    for (const [retired, current] of Object.entries(RETIRED_AUDIT_RESOURCE_TYPES)) {
      expect(isAuditResourceType(retired)).toBe(false);
      expect(isAuditResourceType(current)).toBe(true);
    }
  });

  it('pins each convergence: the name written now for what the web called otherwise', () => {
    expect(RETIRED_AUDIT_RESOURCE_TYPES).toEqual({
      ASSIGNMENTS: 'ASSIGNMENT',
      MODULE: 'MODULES',
      REGRADE_REQUESTS: 'REGRADE_REQUEST',
      TEACHING_STAFF: 'STAFF',
      TEACHING_STAFF_DETAILS: 'STAFF',
      REPOSITORY_ASSIGNMENT: 'GIT_REPO_ASSIGNMENT',
      TEAM: 'TEAMS',
      SLIDE: 'SLIDES',
      SLIDE_CONTENT: 'SLIDES',
      collab_page: 'PAGES',
      collab_deck: 'SLIDES',
    });
  });

  it('gives a reader every name rows about one thing carry', () => {
    expect(auditResourceTypeNames('STAFF')).toEqual([
      'STAFF',
      'TEACHING_STAFF',
      'TEACHING_STAFF_DETAILS',
    ]);
    expect(auditResourceTypeNames('SLIDES')).toEqual([
      'SLIDES',
      'SLIDE',
      'SLIDE_CONTENT',
      'collab_deck',
    ]);
    expect(auditResourceTypeNames('CLASS_GRADES_SCREEN')).toEqual(['CLASS_GRADES_SCREEN']);
  });

  it('names a stored row by what it is written as now', () => {
    expect(currentAuditResourceType('ASSIGNMENTS')).toBe('ASSIGNMENT');
    expect(currentAuditResourceType('collab_page')).toBe('PAGES');
    expect(currentAuditResourceType('GRADES')).toBe('GRADES');
    // Tags were written as TEAMS; their tool tells them from team rows.
    expect(currentAuditResourceType('TEAMS', 'tag_create')).toBe('TAGS');
    expect(currentAuditResourceType('TEAMS', 'web:settings.team.delete_tag')).toBe('TAGS');
    expect(currentAuditResourceType('TEAMS', 'team_create')).toBe('TEAMS');
    expect(currentAuditResourceType('TEAMS')).toBe('TEAMS');
    expect(currentAuditResourceType('UNKNOWN_THING')).toBe('UNKNOWN_THING');
  });

  it('labels old and new rows about the same thing alike', () => {
    expect(auditResourceLabel('REPOSITORY_ASSIGNMENT')).toBe('git repo assignment');
    expect(auditResourceLabel('GIT_REPO_ASSIGNMENT')).toBe('git repo assignment');
    expect(auditResourceLabel('TEAMS', 'tag_create')).toBe(auditResourceLabel('TAGS'));
  });

  it('is re-exported by the audit service subpath', () => {
    expect(auditService.AUDIT_RESOURCE_TYPES).toBe(AUDIT_RESOURCE_TYPES);
    expect(auditService.auditResourceTypeNames).toBe(auditResourceTypeNames);
  });

  it('is the type of every row the service takes', () => {
    expectTypeOf<AuditLogData['resource_type']>().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<
      Parameters<typeof auditService.record>[0]['resource_type']
    >().toEqualTypeOf<AuditResourceType>();
    expectTypeOf<
      Parameters<typeof auditService.create>[0]['resource_type']
    >().toEqualTypeOf<AuditResourceType>();
  });
});
