/**
 * Unit tests for notification deep links.
 *
 * Two things have to hold, and neither was covered while this file was being
 * changed to add the teacher prefix:
 *
 * 1. The link lands somewhere the reader can actually open. The prefixes do not
 *    serve the same sections — there is no /student quiz detail page and no
 *    /admin grading queue — so each resource type has to fall back to a section
 *    that exists under the chosen prefix.
 *
 * 2. The prefix is DETERMINISTIC. A user holding several roles in one classroom
 *    must get the same link every time, whatever order the memberships were
 *    queried in.
 */

import { describe, expect, it } from 'vitest';

const { notificationLink } = await import('../notificationLinks.ts');

const SLUG = 'cs52-26f';

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

const notification = (
  resourceType: string | null,
  { type = 'GENERIC', resourceId = 'res-1' }: { type?: string; resourceId?: string } = {}
) =>
  ({
    type,
    resource_type: resourceType,
    resource_id: resourceId,
    classroom: { slug: SLUG },
    metadata: null,
  }) as unknown as Parameters<typeof notificationLink>[0];

describe('notificationLink — the teacher prefix', () => {
  it('sends a teacher to the teacher tree', () => {
    expect(notificationLink(notification('repository'), ['TEACHER'])).toBe(
      `/teacher/${SLUG}/repos`
    );
  });

  it.each([
    ['quiz', `/teacher/${SLUG}/quizzes/res-1`],
    ['page', `/teacher/${SLUG}/pages/res-1`],
    ['repository', `/teacher/${SLUG}/repos`],
    ['regrade_request', `/teacher/${SLUG}/regrade-requests`],
    // The grading queue exists under /teacher and /assistant, not /admin.
    ['git_repo_assignment', `/teacher/${SLUG}/grading`],
  ])('links a %s to a page the teacher route tree serves', (resourceType, expected) => {
    expect(notificationLink(notification(resourceType), ['TEACHER'])).toBe(expected);
  });

  it('gives every staff role the quiz DETAIL page, which their trees have', () => {
    // The assistant prefix now serves the quiz management screens too, so it
    // gets the deep link like the other staff trees. Only a student lands on
    // the list, because the student tree has no detail route.
    expect(notificationLink(notification('quiz'), ['TEACHER'])).toBe(
      `/teacher/${SLUG}/quizzes/res-1`
    );
    expect(notificationLink(notification('quiz'), ['ASSISTANT'])).toBe(
      `/assistant/${SLUG}/quizzes/res-1`
    );
    expect(notificationLink(notification('quiz'), ['STUDENT'])).toBe(`/student/${SLUG}/quizzes`);
  });

  it('falls back to the class root for an assignment, which only students list', () => {
    expect(notificationLink(notification('assignment'), ['TEACHER'])).toBe(`/teacher/${SLUG}`);
    expect(notificationLink(notification('assignment'), ['STUDENT'])).toBe(
      `/student/${SLUG}/assignments`
    );
  });
});

describe('notificationLink — the default branch', () => {
  it.each([
    ['OWNER', `/admin/${SLUG}`],
    ['TEACHER', `/teacher/${SLUG}`],
    ['ASSISTANT', `/assistant/${SLUG}`],
    ['STUDENT', `/student/${SLUG}`],
  ] as const)('sends an unrecognised resource type to the %s class root', (role, expected) => {
    expect(notificationLink(notification('something_new'), [role])).toBe(expected);
  });

  it('handles a missing resource type the same way', () => {
    expect(notificationLink(notification(null), ['TEACHER'])).toBe(`/teacher/${SLUG}`);
  });

  it('returns null when there is no classroom or no role to pick', () => {
    expect(notificationLink(notification('page'), [])).toBeNull();
    expect(notificationLink(notification('page'), null)).toBeNull();
    expect(
      notificationLink(
        { ...notification('page'), classroom: null } as unknown as Parameters<
          typeof notificationLink
        >[0],
        ['TEACHER']
      )
    ).toBeNull();
  });
});

describe('notificationLink — the prefix is deterministic', () => {
  it('picks the highest role, not the first one in the array', () => {
    // Same set, two orderings. Selecting by array position would answer
    // differently for each.
    const orderings: Role[][] = [
      ['TEACHER', 'OWNER'],
      ['OWNER', 'TEACHER'],
    ];
    for (const roles of orderings) {
      expect(notificationLink(notification('repository'), roles)).toBe(`/admin/${SLUG}/repos`);
    }
  });

  it.each([
    [['TEACHER', 'ASSISTANT'], 'teacher'],
    [['ASSISTANT', 'TEACHER'], 'teacher'],
    [['STUDENT', 'ASSISTANT'], 'assistant'],
    [['ASSISTANT', 'STUDENT'], 'assistant'],
  ] as [Role[], string][])('resolves %j to the /%s prefix', (roles, prefix) => {
    expect(notificationLink(notification('repository'), roles)).toBe(`/${prefix}/${SLUG}/repos`);
  });

  it('still routes a role-targeted notification to that role, not the highest', () => {
    // An owner who is also enrolled reads a student announcement as a student.
    expect(
      notificationLink(notification('page', { type: 'PAGE_PUBLISHED' }), ['OWNER', 'STUDENT'])
    ).toBe(`/student/${SLUG}/pages/res-1`);

    // And a grading assignment is read in the assistant's view.
    expect(
      notificationLink(notification('git_repo_assignment', { type: 'TA_GRADING_ASSIGNED' }), [
        'OWNER',
        'ASSISTANT',
      ])
    ).toBe(`/assistant/${SLUG}/grading`);
  });

  it('ignores a role-targeted rule when the reader does not hold that role', () => {
    // A teacher who is not enrolled still gets the teacher view of a student
    // announcement rather than a /student link they cannot open.
    expect(notificationLink(notification('page', { type: 'PAGE_PUBLISHED' }), ['TEACHER'])).toBe(
      `/teacher/${SLUG}/pages/res-1`
    );
  });
});
