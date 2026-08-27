/**
 * Unit tests for the "Preview as" state resolution.
 *
 * This is the security-bearing half of the feature, so it is pinned directly
 * rather than through a component. The property that matters is one-way: a
 * viewer who does not hold a real OWNER membership in THIS classroom must never
 * resolve to a preview state, whatever prefix they are on and whatever else
 * they hold elsewhere.
 *
 * Worth restating what "preview" is, because it bounds what these tests can
 * even be about: it relabels the DISPLAYED role of an owner's own view. The
 * server resolves every request through `resolveHighestMembership` against the
 * database, so the URL prefix is not an authorization input and none of this
 * can grant access. What it CAN do wrong is mislead — showing a preview
 * control to someone who has no business seeing one, or leaving an owner unsure
 * which view they are in. That is what is tested here.
 */

import { describe, expect, it, vi } from 'vitest';

// The real role/path mapping, reached relatively because `~` is not aliased in
// vitest.config.ts. Testing against the real table is the point — a preview
// prefix that drifted from roleSettings would be a broken link.
vi.mock('~/constants/roleSettings', async () => await import('../../constants/roleSettings'));

const {
  resolvePreviewState,
  holdsOwnerMembership,
  previewPathFor,
  ownerExitPath,
  previewRoleLabel,
  PREVIEWABLE_ROLES,
} = await import('../previewRole.ts');

const CLASS = 'cs52-26f';
const OTHER_CLASS = 'cs10-26f';

const membership = (role: string, login = CLASS) => ({ role, organization: { login } });

const stateFor = (memberships: ReturnType<typeof membership>[], rolePrefix: string) =>
  resolvePreviewState({ memberships, classroomSlug: CLASS, rolePrefix });

describe('holdsOwnerMembership', () => {
  it('is true only for a real OWNER row in THIS classroom', () => {
    expect(holdsOwnerMembership([membership('OWNER')], CLASS)).toBe(true);
  });

  it('is false when the OWNER row belongs to a different classroom', () => {
    // Owning some other class is not owning this one.
    expect(holdsOwnerMembership([membership('OWNER', OTHER_CLASS)], CLASS)).toBe(false);
  });

  it.each([['TEACHER'], ['ASSISTANT'], ['STUDENT']])('is false for a %s row', role => {
    expect(holdsOwnerMembership([membership(role)], CLASS)).toBe(false);
  });

  it('is false with no memberships, no classroom, or missing data', () => {
    expect(holdsOwnerMembership([], CLASS)).toBe(false);
    expect(holdsOwnerMembership(undefined, CLASS)).toBe(false);
    expect(holdsOwnerMembership([membership('OWNER')], undefined)).toBe(false);
    expect(holdsOwnerMembership([{ role: 'OWNER', organization: null }], CLASS)).toBe(false);
  });
});

describe('resolvePreviewState — a non-owner can never reach the preview state', () => {
  it.each([
    ['TEACHER', 'teacher'],
    ['ASSISTANT', 'assistant'],
    ['STUDENT', 'student'],
  ])('gives a %s on their own prefix no control and no preview', (role, prefix) => {
    // A teacher on /teacher is in their OWN view, not previewing anything.
    expect(stateFor([membership(role)], prefix)).toEqual({
      canPreview: false,
      previewRole: null,
      isPreviewing: false,
    });
  });

  it.each([
    ['TEACHER', 'student'],
    ['ASSISTANT', 'teacher'],
    ['STUDENT', 'admin'],
  ])('gives a %s who hand-types the /%s prefix nothing', (role, prefix) => {
    // The load-bearing case: typing another role's URL must not manufacture a
    // preview. It does not here, and it does not in root.tsx either — that
    // fallback requires an OWNER membership in this classroom to fire at all.
    expect(stateFor([membership(role)], prefix)).toMatchObject({
      canPreview: false,
      isPreviewing: false,
    });
  });

  it('gives an owner of ANOTHER classroom nothing here', () => {
    expect(stateFor([membership('OWNER', OTHER_CLASS), membership('TEACHER')], 'student')).toEqual({
      canPreview: false,
      previewRole: null,
      isPreviewing: false,
    });
  });

  it('gives a signed-out or membership-less viewer nothing', () => {
    expect(stateFor([], 'teacher')).toMatchObject({ canPreview: false });
    expect(
      resolvePreviewState({ memberships: null, classroomSlug: CLASS, rolePrefix: 'teacher' })
    ).toMatchObject({ canPreview: false });
  });
});

describe('resolvePreviewState — an owner', () => {
  const owner = [membership('OWNER')];

  it('is offered the control on their own prefix, but is not previewing', () => {
    expect(stateFor(owner, 'admin')).toEqual({
      canPreview: true,
      previewRole: null,
      isPreviewing: false,
    });
  });

  it.each([
    ['teacher', 'TEACHER'],
    ['assistant', 'ASSISTANT'],
    ['student', 'STUDENT'],
  ])('is previewing as %s on the /%s prefix', (prefix, expected) => {
    expect(stateFor(owner, prefix)).toEqual({
      canPreview: true,
      previewRole: expected,
      isPreviewing: true,
    });
  });

  it('is still offered the control while previewing, so there is a way back', () => {
    // The exit path depends on this: a control gated on the DISPLAYED role
    // would disappear the moment preview began.
    expect(stateFor(owner, 'student').canPreview).toBe(true);
  });

  it('is not "previewing" on a prefix that names no role', () => {
    // An unrelated or future prefix must not be reported as a preview.
    expect(stateFor(owner, 'oauth')).toEqual({
      canPreview: true,
      previewRole: null,
      isPreviewing: false,
    });
  });

  it('resolves the same when they ALSO hold the previewed role for real', () => {
    // An owner who is also enrolled as a student still gets the indicator on
    // /student — the invariant is that they always know which view they are in,
    // not that the relabel was the only way they could have got there.
    expect(stateFor([membership('OWNER'), membership('STUDENT')], 'student')).toMatchObject({
      canPreview: true,
      previewRole: 'STUDENT',
      isPreviewing: true,
    });
  });

  it('is offered nothing outside a classroom', () => {
    expect(
      resolvePreviewState({ memberships: owner, classroomSlug: undefined, rolePrefix: 'admin' })
    ).toMatchObject({ canPreview: false });
  });
});

describe('preview navigation targets', () => {
  it.each([
    ['TEACHER', `/teacher/${CLASS}/dashboard`],
    ['ASSISTANT', `/assistant/${CLASS}/dashboard`],
    ['STUDENT', `/student/${CLASS}/dashboard`],
  ] as const)('sends a %s preview to its dashboard', (role, expected) => {
    // Dashboard rather than the current section: the prefixes do not serve the
    // same sections, so carrying the section across would 404.
    expect(previewPathFor(role, CLASS)).toBe(expected);
  });

  it('exits to the owner prefix', () => {
    expect(ownerExitPath(CLASS)).toBe(`/admin/${CLASS}/dashboard`);
  });

  it('never offers OWNER as something to preview', () => {
    expect(PREVIEWABLE_ROLES).not.toContain('OWNER');
  });

  it('labels roles for display', () => {
    expect(previewRoleLabel('TEACHER')).toBe('Teacher');
    expect(previewRoleLabel('ASSISTANT')).toBe('Assistant');
  });
});
