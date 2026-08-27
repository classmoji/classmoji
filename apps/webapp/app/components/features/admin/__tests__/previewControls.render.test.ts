/**
 * REAL render tests for the two "Preview as" controls.
 *
 * The state logic is pinned in app/utils/__tests__/previewRole.test.ts; what is
 * checked here is that the components honour it — that the switcher draws for
 * owners and for nobody else, and that an active preview always draws the
 * indicator carrying a way out.
 *
 * The second half is the one that would hurt if it broke: an owner who cannot
 * tell they are previewing, or who has no exit, is worse off than an owner with
 * no preview feature at all.
 *
 * apps/webapp has no @testing-library/react — see package.json. Following the
 * precedent in admin.$class.students/__tests__/studentsTable.render.test.ts,
 * this mounts the components for real with `react-dom/server` and asserts
 * against the produced markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// The real helpers, reached relatively (`~` is not aliased in vitest.config.ts).
vi.mock('~/utils/previewRole', async () => await import('../../../../utils/previewRole.ts'));
vi.mock('~/constants/roleSettings', async () => await import('../../../../constants/roleSettings'));

const PreviewRoleSwitcher = (await import('../PreviewRoleSwitcher.tsx')).default;
const PreviewModeBanner = (await import('../PreviewModeBanner.tsx')).default;
const { resolvePreviewState } = await import('../../../../utils/previewRole.ts');

const CLASS = 'cs52-26f';

const membership = (role: string, login = CLASS) => ({ role, organization: { login } });

const stateFor = (roles: string[], rolePrefix: string) =>
  resolvePreviewState({
    memberships: roles.map(role => membership(role)),
    classroomSlug: CLASS,
    rolePrefix,
  });

const render = (element: React.ReactElement) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/'] }, element));

const switcher = (roles: string[], rolePrefix: string, collapsed = false) =>
  render(
    createElement(PreviewRoleSwitcher, {
      preview: stateFor(roles, rolePrefix),
      classroomSlug: CLASS,
      collapsed,
    })
  );

const banner = (roles: string[], rolePrefix: string) =>
  render(
    createElement(PreviewModeBanner, {
      preview: stateFor(roles, rolePrefix),
      classroomSlug: CLASS,
    })
  );

describe('PreviewRoleSwitcher — who sees it', () => {
  it('renders for an owner in their own view', () => {
    const html = switcher(['OWNER'], 'admin');

    expect(html).toContain('data-preview-switcher');
    expect(html).toContain('Preview as');
  });

  it.each([['TEACHER'], ['ASSISTANT'], ['STUDENT']])('renders nothing for a %s', role => {
    expect(switcher([role], role.toLowerCase())).toBe('');
  });

  it('renders nothing for a non-owner who hand-typed another prefix', () => {
    // The case the control must not reward: a teacher on /student.
    expect(switcher(['TEACHER'], 'student')).toBe('');
  });

  it('renders nothing for an owner of a DIFFERENT classroom', () => {
    const html = render(
      createElement(PreviewRoleSwitcher, {
        preview: resolvePreviewState({
          memberships: [membership('OWNER', 'some-other-class')],
          classroomSlug: CLASS,
          rolePrefix: 'teacher',
        }),
        classroomSlug: CLASS,
      })
    );

    expect(html).toBe('');
  });

  it('renders nothing outside a classroom', () => {
    const html = render(
      createElement(PreviewRoleSwitcher, {
        preview: stateFor(['OWNER'], 'admin'),
        classroomSlug: undefined,
      })
    );

    expect(html).toBe('');
  });
});

describe('PreviewRoleSwitcher — what it says while previewing', () => {
  it.each([
    ['teacher', 'Teacher'],
    ['assistant', 'Assistant'],
    ['student', 'Student'],
  ])('names the role being previewed on /%s', (prefix, label) => {
    const html = switcher(['OWNER'], prefix);

    expect(html).toContain(`Previewing: ${label}`);
  });

  it('still renders while previewing, so the way back stays reachable', () => {
    // A control gated on the DISPLAYED role would vanish here — the store role
    // during a preview is the relabeled one, not OWNER.
    expect(switcher(['OWNER'], 'student')).toContain('data-preview-switcher');
  });

  it('keeps a label available when the sidebar is collapsed', () => {
    const html = switcher(['OWNER'], 'teacher', true);

    expect(html).toContain('data-preview-switcher');
    expect(html).toContain('aria-label="Previewing: Teacher"');
  });
});

describe('PreviewModeBanner — the indicator', () => {
  it('renders nothing when the owner is in their own view', () => {
    expect(banner(['OWNER'], 'admin')).toBe('');
  });

  it.each([['TEACHER'], ['ASSISTANT'], ['STUDENT']])(
    'renders nothing for a %s in their own view',
    role => {
      expect(banner([role], role.toLowerCase())).toBe('');
    }
  );

  it('renders nothing for a non-owner on another prefix', () => {
    expect(banner(['TEACHER'], 'student')).toBe('');
  });

  it.each([
    ['teacher', 'Teacher'],
    ['assistant', 'Assistant'],
    ['student', 'Student'],
  ])('names the previewed role on /%s', (prefix, label) => {
    const html = banner(['OWNER'], prefix);

    expect(html).toContain('data-preview-banner');
    expect(html).toContain(label);
  });

  it('always offers a one-click way back to the owner view', () => {
    const html = banner(['OWNER'], 'student');

    expect(html).toContain(`/admin/${CLASS}/dashboard`);
    expect(html).toContain('Back to owner view');
  });

  it('says the owner is still themselves, not signed in as someone else', () => {
    // The distinction from ImpersonationBanner, which is about identity. This
    // one must not read as "you are now a student".
    const html = banner(['OWNER'], 'student');

    expect(html).toContain('Preview mode');
    expect(html).toContain('still signed in as yourself');
  });

  it('carries both light and dark styling', () => {
    // The app renders light and dark from the same markup, so a banner styled
    // for one is invisible in the other.
    const html = banner(['OWNER'], 'teacher');

    expect(html).toMatch(/bg-violet-100/);
    expect(html).toMatch(/dark:bg-violet-500\/20/);
  });
});
