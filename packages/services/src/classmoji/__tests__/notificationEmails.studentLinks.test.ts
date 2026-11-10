/**
 * Where the button of a student's assignment and repository emails goes: the
 * assignment itself on their Assignments page (it used to be the class
 * picker), through `/?redirect=` so a signed-out reader lands there after
 * signing in. Everything else keeps the app link.
 */
import { describe, expect, it } from 'vitest';
import { renderEmail } from '../notificationEmails.ts';

const APP = process.env.WEBAPP_URL ?? 'https://app.classmoji.io';

const base = {
  classroomName: 'CS 50',
  classroomSlug: 'cs50-fall-2026',
  recipientName: 'Ada',
};

const actionUrl = (ctx: Parameters<typeof renderEmail>[0]) =>
  renderEmail(ctx).template.variables.ACTION_URL;

const through = (path: string) => `${APP}/?redirect=${encodeURIComponent(path)}`;

describe('student notification emails: the button opens the assignment', () => {
  it('a published repository opens the assignment submitted through it', () => {
    expect(
      actionUrl({
        ...base,
        type: 'REPOSITORY_PUBLISHED',
        title: 'Repository published: lab5',
        resourceType: 'repository',
        resourceId: 'repo-1',
        metadata: { assignment_id: 'asg-1' },
      })
    ).toBe(through('/student/cs50-fall-2026/assignments?assignment=asg-1'));
  });

  it("a repository with no assignment opens the student's repositories", () => {
    expect(
      actionUrl({
        ...base,
        type: 'REPOSITORY_PUBLISHED',
        title: 'Repository published: starter',
        resourceType: 'repository',
        resourceId: 'repo-1',
      })
    ).toBe(through('/student/cs50-fall-2026/repos'));
  });

  it('a due date change opens that assignment', () => {
    expect(
      actionUrl({
        ...base,
        type: 'ASSIGNMENT_DUE_DATE_CHANGED',
        title: 'Due date changed: Lab 5',
        resourceType: 'assignment',
        resourceId: 'asg-1',
      })
    ).toBe(through('/student/cs50-fall-2026/assignments?assignment=asg-1'));
  });

  it('keeps the app link without a classroom slug, and for other notices', () => {
    expect(
      actionUrl({
        ...base,
        classroomSlug: null,
        type: 'REPOSITORY_PUBLISHED',
        title: 'Repository published: lab5',
        resourceType: 'repository',
        resourceId: 'repo-1',
        metadata: { assignment_id: 'asg-1' },
      })
    ).toBe(`${APP}/select-organization`);
    expect(
      actionUrl({
        ...base,
        type: 'TA_GRADING_ASSIGNED',
        title: 'New grading: Lab 5',
        resourceType: 'git_repo_assignment',
        resourceId: 'gra-1',
      })
    ).toBe(`${APP}/select-organization`);
    expect(
      actionUrl({
        ...base,
        type: 'REPOSITORY_UNPUBLISHED',
        title: 'Repository unpublished: lab5',
        resourceType: 'repository',
        resourceId: 'repo-1',
      })
    ).toBe(`${APP}/select-organization`);
  });
});
