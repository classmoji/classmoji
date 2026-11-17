/**
 * The root loader's user read (ROOT_USER_INCLUDE, every root.tsx lookup):
 * each membership's classroom is read without the invite link's code, the
 * plan owner's id and the creator's id, and with only the git organization
 * and settings columns the client reads.
 */
import { describe, expect, it } from 'vitest';
import {
  CLASSROOM_SETTINGS_SELECT,
  ROOT_GIT_ORGANIZATION_SELECT,
  ROOT_MEMBERSHIP_SELECT,
  ROOT_USER_INCLUDE,
} from '../types';

describe('ROOT_USER_INCLUDE', () => {
  it("reads each membership's classroom without its invite code, plan owner or creator", () => {
    expect(ROOT_USER_INCLUDE.classroom_memberships).toEqual({ select: ROOT_MEMBERSHIP_SELECT });
    expect(ROOT_MEMBERSHIP_SELECT.classroom.omit).toEqual({
      join_code: true,
      plan_owner_id: true,
      created_by: true,
    });
  });

  it('reads the organization and settings by their selects', () => {
    expect(ROOT_MEMBERSHIP_SELECT.classroom.include).toEqual({
      git_organization: { select: ROOT_GIT_ORGANIZATION_SELECT },
      settings: { select: CLASSROOM_SETTINGS_SELECT },
    });
    expect(Object.keys(ROOT_GIT_ORGANIZATION_SELECT).sort()).toEqual(
      ['base_url', 'id', 'login', 'provider', 'provider_id'].sort()
    );
  });
});
