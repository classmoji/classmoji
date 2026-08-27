/**
 * REAL render tests for the Teaching Staff screen and its add form.
 *
 * Two things changed that only a render can check.
 *
 * 1. The page used to draw for an owner and nobody else — the loader was
 *    OWNER-gated, so the non-owner branch had never executed. It now serves
 *    /assistant/:class/staff and /teacher/:class/staff, where `canManage` is
 *    false and every management affordance has to be absent, not merely
 *    disabled. Absent is the claim, so the markup is the evidence.
 * 2. The add form can grant OWNER, which must never be one click.
 *
 * apps/webapp has NO @testing-library/react — see package.json. Rather than fake
 * a render, this mounts the components for real with `react-dom/server`, which
 * executes every column `render` callback on every row exactly as the server
 * render of the page does.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// Real implementations, reached relatively because `~` is not aliased in
// vitest.config.ts.
vi.mock('~/components', async () => ({
  TableActionButtons: (await import('../../../components/ui/buttons/TableActionButtons')).default,
  UserThumbnailView: (await import('../../../components/features/profile/UserThumbnailView'))
    .default,
  SearchInput: () => null,
  ButtonNew: ({ children }: { children?: React.ReactNode }) =>
    createElement('button', { type: 'button' }, children),
}));

vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: { submit: vi.fn() }, notify: vi.fn() }),
  useDisclosure: () => ({ show: vi.fn(), close: vi.fn(), visible: false }),
}));

vi.mock('~/constants', () => ({
  ActionTypes: { SAVE_USER: 'save-user', REMOVE_USER: 'remove-user' },
}));

vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));

vi.mock('@classmoji/auth/client', () => ({
  authClient: { admin: { impersonateUser: vi.fn() } },
}));

// The loader half of the route module pulls in the service layer and the auth
// helpers; only the component is under test here.
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { classroomMembership: {}, staff: {} },
  StaffServiceError: class StaffServiceError extends Error {},
}));
vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: vi.fn(),
  requireClassroomAdmin: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('~/utils/helpers', () => ({ waitForRunCompletion: vi.fn() }));

const StaffScreen = (await import('../route.tsx')).default;
const FormStaff = (await import('../FormStaff')).default;

// ─── Row fixtures, shaped exactly as the loader emits them ──────────────────

const row = (over: Record<string, unknown>) => ({
  id: 'user-1',
  name: 'Ada Lovelace',
  login: 'ada',
  avatar_url: 'https://avatars.githubusercontent.com/u/424242?v=4',
  role: 'ASSISTANT',
  is_grader: false,
  has_accepted_invite: true,
  ...over,
});

const OWNER_ROW = row({ id: 'user-owner', name: 'Grace Hopper', login: 'grace', role: 'OWNER' });
const TEACHER_ROW = row({ id: 'user-teach', name: 'Alan Turing', login: 'alan', role: 'TEACHER' });
const ASSISTANT_ROW = row({});

const ALL_ROWS = [OWNER_ROW, TEACHER_ROW, ASSISTANT_ROW];

const renderScreen = (props: { staff: Record<string, unknown>[]; canManage: boolean }) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/admin/cs52-26f/staff'] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/:role/:class/staff',
          element: createElement(StaffScreen, { loaderData: props } as never),
        })
      )
    )
  );

const renderForm = (initialRole?: 'ASSISTANT' | 'TEACHER' | 'OWNER') =>
  renderToStaticMarkup(createElement(FormStaff, { close: vi.fn(), initialRole }));

// ─── The read-only branch, which had never rendered ─────────────────────────

describe('Teaching Staff screen with canManage=false', () => {
  it('renders every role without throwing', () => {
    expect(() => renderScreen({ staff: ALL_ROWS, canManage: false })).not.toThrow();
  });

  it('still shows the whole team — that is the point of the widening', () => {
    const html = renderScreen({ staff: ALL_ROWS, canManage: false });

    expect(html).toContain('Grace Hopper');
    expect(html).toContain('Alan Turing');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('Owner');
    expect(html).toContain('Teacher');
    expect(html).toContain('Assistant');
  });

  it('offers no way in to the add form', () => {
    const html = renderScreen({ staff: ALL_ROWS, canManage: false });

    expect(html).not.toContain('New staff member');
    // The modal that holds the role selector is not mounted at all, so the
    // selector is unreachable rather than merely hidden.
    expect(html).not.toContain('Add Teaching Staff');
  });

  it('drops the whole Actions column, not just its buttons', () => {
    const html = renderScreen({ staff: ALL_ROWS, canManage: false });

    expect(html).not.toContain('Actions');
    expect(html).not.toContain('Remove');
    expect(html).not.toContain('View as');
  });

  it('shows the grader flag as text, with no control to change it', () => {
    const html = renderScreen({ staff: [row({ is_grader: true })], canManage: false });

    expect(html).toContain('Grader Role');
    expect(html).not.toContain('type="radio"');
  });
});

// ─── The manage branch ──────────────────────────────────────────────────────

describe('Teaching Staff screen with canManage=true', () => {
  it('offers the add form and the actions column', () => {
    const html = renderScreen({ staff: ALL_ROWS, canManage: true });

    expect(html).toContain('New staff member');
    expect(html).toContain('Actions');
    expect(html).toContain('Remove');
  });

  it('renders a grader toggle for the roles that grade', () => {
    const assistant = renderScreen({ staff: [ASSISTANT_ROW], canManage: true });
    const teacher = renderScreen({ staff: [TEACHER_ROW], canManage: true });

    expect(assistant).toContain('type="radio"');
    expect(teacher).toContain('type="radio"');
  });

  it('renders NO grader toggle on an owner row — the service refuses the flag', () => {
    // updateStaff throws grader_flag_invalid for OWNER, so a control that could
    // only ever fail must not exist.
    const html = renderScreen({ staff: [OWNER_ROW], canManage: true });

    expect(html).not.toContain('type="radio"');
  });

  it('offers Remove on an owner row but not the grading drawer', () => {
    // The drawer is a grading-progress view; an owner has no grading queue.
    const html = renderScreen({ staff: [OWNER_ROW], canManage: true });

    expect(html).toContain('Remove');
    expect(html).not.toContain('data-testid="table-action-view"');
  });

  it('offers the grading drawer on the roles that grade', () => {
    expect(renderScreen({ staff: [ASSISTANT_ROW], canManage: true })).toContain(
      'data-testid="table-action-view"'
    );
    expect(renderScreen({ staff: [TEACHER_ROW], canManage: true })).toContain(
      'data-testid="table-action-view"'
    );
  });
});

// ─── The add form ───────────────────────────────────────────────────────────

describe('FormStaff — the role selector', () => {
  it('offers all three staff roles', () => {
    const html = renderForm();

    expect(html).toContain('Assistant');
    expect(html).toContain('Teacher');
    expect(html).toContain('Co-owner');
  });

  it('opens on Assistant, the common case', () => {
    const html = renderForm();

    expect(html).toContain('Grades work assigned to them');
    expect(html).not.toContain('full control of this classroom');
  });

  it('submits directly for a non-owner role', () => {
    // Nothing to confirm: a submit button that posts on click.
    expect(renderForm('TEACHER')).toContain('type="submit"');
    expect(renderForm('TEACHER')).toContain('Add staff member');
  });
});

describe('FormStaff — what the instructor has to type', () => {
  it('demands the username and nothing else', () => {
    // The form used to require a name and an email because it filled them in
    // itself from a client-side GitHub lookup. That lookup is gone and addStaff
    // falls back to the git profile for both, so requiring them only blocked an
    // invite. antd marks a required field's label with this class, so the count
    // is the evidence that exactly one field is mandatory.
    const html = renderForm();

    expect(html.match(/ant-form-item-required/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/ant-form-item-required[^>]*>GitHub Username/);
  });

  it('labels name and email as optional and says what they default to', () => {
    const html = renderForm();

    expect(html).toContain('Name (optional)');
    expect(html).toContain('Email (optional)');
    expect(html).toContain('Defaults to their GitHub name');
    expect(html).toContain('Defaults to their GitHub email');
  });
});

describe('FormStaff — granting OWNER', () => {
  it('cannot be submitted by the button itself', () => {
    // The submit control degrades to a plain button wrapped in a Popconfirm, so
    // the click opens the confirmation instead of posting the form. If this
    // ever reads type="submit" again, granting ownership became one click.
    const html = renderForm('OWNER');

    expect(html).toContain('Add co-owner');
    expect(html).not.toContain('type="submit"');
    expect(html).toContain('type="button"');
  });

  it('says plainly what a co-owner can do before the click', () => {
    const html = renderForm('OWNER');

    expect(html).toContain('full control of this classroom');
    expect(html).toContain('deleting');
  });

  it('says a co-owner is a Classmoji role, not a GitHub organization admin', () => {
    // The distinction is load-bearing: the danger-zone GitHub cleanup runs with
    // the requester's own credentials and will fail for a co-owner who is not
    // an org admin.
    const html = renderForm('OWNER');

    expect(html).toContain('not a GitHub organization admin');
    expect(html).toContain('GitHub credentials');
  });
});
