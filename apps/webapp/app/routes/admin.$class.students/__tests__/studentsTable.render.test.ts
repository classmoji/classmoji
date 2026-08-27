/**
 * REAL render tests for StudentsTable outside the plain OWNER-on-/admin shape.
 *
 * Why this file exists: until this branch the table only ever RENDERED for an
 * owner with the full payload. The /admin layout's OWNER check is client-side
 * (`RequireRole`) and its loader catches the thrown auth Response and degrades,
 * so a non-owner reaching /admin/:class/students gets a 200 and an emptied
 * shell — the table itself never drew. The assistant prefix changes that: it
 * serves the same loader and the same component, so a TA now renders this table
 * for real, and the loader STRIPS keys (email, provider_email, school_id,
 * letter_grade, comment, school_email) from the payload rather than nulling
 * them. Any column `render`, sorter or handler that touches an absent key would
 * throw and blank the page for the whole teaching team.
 *
 * The table now takes TWO flags, and they are not the same question:
 *   isOwner   — may this viewer see the contact columns.
 *   canManage — may this viewer act from THIS page (owner AND /admin prefix).
 * The third combination, isOwner=true with canManage=false, is what an owner
 * gets if they hand-type the assistant URL, and it is covered below.
 *
 * apps/webapp has NO @testing-library/react (or /dom, or /jest-dom) — see
 * package.json. Rather than fake a render, this mounts the component for real
 * with `react-dom/server`, which executes every column `render` callback on
 * every row exactly as the server render of the page does. Assertions run
 * against the produced markup.
 *
 * Rows here are built to mirror the loader byte for byte: the non-OWNER rows
 * OMIT the owner-only keys (they are not `null`), and the invite row is shaped
 * the way the route component builds it from `invitations`.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// Real implementations, reached relatively because `~` is not aliased in
// vitest.config.ts. These two are the whole view surface the table pulls from
// the barrel, and UserThumbnailView is precisely the component fed a row that
// no longer carries contact fields.
vi.mock('~/components', async () => ({
  TableActionButtons: (await import('../../../components/ui/buttons/TableActionButtons')).default,
  UserThumbnailView: (await import('../../../components/features/profile/UserThumbnailView'))
    .default,
}));

vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({ fetcher: { submit: vi.fn() }, notify: vi.fn() }),
}));

vi.mock('~/constants', () => ({ ActionTypes: { REMOVE_USER: 'remove-user' } }));

vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));

vi.mock('@classmoji/auth/client', () => ({
  authClient: { admin: { impersonateUser: vi.fn() } },
}));
vi.mock('~/utils/impersonationReturn', () => ({ rememberImpersonationReturn: vi.fn() }));

const StudentsTable = (await import('../StudentsTable')).default;

// ─── Row fixtures ───────────────────────────────────────────────────────────

/**
 * Exactly the keys the loader emits for a non-OWNER staff viewer. `image` is
 * the User column; `avatar_url` is the alias UserThumbnailView actually reads,
 * which the loader maps for it.
 */
const ASSISTANT_VISIBLE_ROW = {
  id: 'student-1',
  name: 'Ada Lovelace',
  login: 'ada',
  image: 'https://example.test/ada.png',
  avatar_url: 'https://example.test/ada.png',
  is_grader: false,
  has_accepted_invite: true,
};

/** The same row as an OWNER receives it. */
const OWNER_VISIBLE_ROW = {
  ...ASSISTANT_VISIBLE_ROW,
  email: 'ada@school.test',
  provider_email: 'ada@github.test',
  school_id: 'F00123',
  letter_grade: 'A-',
  comment: 'strong on recursion',
};

/** A student who never accepted — `login` is null, which the actions cell reads. */
const PENDING_ROW = {
  id: 'student-2',
  name: 'Alan Turing',
  login: null,
  image: null,
  avatar_url: null,
  is_grader: false,
  has_accepted_invite: false,
};

/**
 * A pending invitation, shaped the way the route component builds it. For a
 * non-OWNER `school_email` is absent from the loader payload, so `email` here
 * is `undefined` — the case that would break any `.toLowerCase()` on it.
 */
const inviteRow = (schoolEmail?: string) => ({
  id: 'invite-1',
  name: 'Grace Hopper',
  email: schoolEmail,
  school_id: null,
  login: 'pending-invite',
  has_accepted_invite: false,
  avatar_url: 'https://github.com/github.png?size=460',
  _isInvite: true,
});

const render = (props: {
  students: Record<string, unknown>[];
  isOwner: boolean;
  /** Defaults to isOwner — the /admin case, where the two flags agree. */
  canManage?: boolean;
  query?: string;
}) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: ['/assistant/cs52-26f/students'] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/:role/:class/students',
          element: createElement(StudentsTable, {
            students: props.students as never,
            classroom: { id: 'class-1' },
            query: props.query ?? '',
            isOwner: props.isOwner,
            canManage: props.canManage ?? props.isOwner,
          }),
        })
      )
    )
  );

const OWNER_ONLY_VALUES = [
  'ada@school.test',
  'ada@github.test',
  'F00123',
  'strong on recursion',
  'grace@school.test',
];

// ─── The branch that has never rendered before ──────────────────────────────

describe('StudentsTable with isOwner=false (the assistant view)', () => {
  const rows = [ASSISTANT_VISIBLE_ROW, PENDING_ROW, inviteRow()];

  it('renders without throwing on rows whose owner-only keys are ABSENT', () => {
    expect(() => render({ students: rows, isOwner: false })).not.toThrow();
  });

  it('still shows identity and status for every row', () => {
    const html = render({ students: rows, isOwner: false });

    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('@ada');
    expect(html).toContain('Alan Turing');
    expect(html).toContain('Grace Hopper');
    expect(html).toContain('Active');
    expect(html).toContain('Pending');
  });

  it('emits no contact or grade value anywhere in the markup', () => {
    const html = render({ students: rows, isOwner: false });

    for (const value of OWNER_ONLY_VALUES) {
      expect(html).not.toContain(value);
    }
  });

  it('builds no contact columns at all — not even the headers', () => {
    const html = render({ students: rows, isOwner: false });

    expect(html).not.toContain('School ID');
    // 'Email' as a column header. The word appears nowhere else in this table.
    expect(html).not.toContain('Email');
  });

  it('renders an empty actions cell — no remove, no view, no impersonation', () => {
    const html = render({ students: rows, isOwner: false });

    expect(html).not.toContain('View as');
    expect(html).not.toContain('Remove');
    expect(html).not.toContain('data-testid="table-action-view"');
  });

  it('renders the empty state without throwing when the roster is empty', () => {
    expect(() => render({ students: [], isOwner: false })).not.toThrow();
    expect(render({ students: [], isOwner: false })).toContain('No students enrolled yet');
    expect(render({ students: [], isOwner: false, query: 'zzz' })).toContain('No students found');
  });
});

// ─── The owner branch, so the assertions above are not vacuous ──────────────

describe('StudentsTable with isOwner=true (the pre-existing view)', () => {
  const rows = [OWNER_VISIBLE_ROW, PENDING_ROW, inviteRow('grace@school.test')];

  it('renders without throwing', () => {
    expect(() => render({ students: rows, isOwner: true })).not.toThrow();
  });

  it('does show the contact columns and their values', () => {
    const html = render({ students: rows, isOwner: true });

    expect(html).toContain('School ID');
    expect(html).toContain('Email');
    expect(html).toContain('ada@school.test');
    expect(html).toContain('F00123');
    expect(html).toContain('grace@school.test');
  });

  it('does show the owner-only row actions', () => {
    const html = render({ students: rows, isOwner: true });

    expect(html).toContain('View as');
    expect(html).toContain('Remove');
    expect(html).toContain('data-testid="table-action-view"');
  });

  it('renders the avatar the loader now supplies as avatar_url', () => {
    // UserThumbnailView reads `avatar_url`; the User model calls the column
    // `image`, so the loader maps it. Without the mapping no avatar drew at all.
    const html = render({ students: rows, isOwner: true });

    expect(html).toContain('https://example.test/ada.png');
  });
});

// ─── An OWNER who arrived on the assistant prefix ───────────────────────────

/**
 * The combination the prefix split exists for. The same loader serves
 * /assistant/:class/students, where the route exports no `action` and has no
 * nested detail route — so an owner who hand-types that URL must see their
 * fields but none of the controls, because every one of those controls resolves
 * against the current prefix and would fail there.
 */
describe('StudentsTable with isOwner=true but canManage=false', () => {
  const rows = [OWNER_VISIBLE_ROW, PENDING_ROW, inviteRow('grace@school.test')];
  const html = () => render({ students: rows, isOwner: true, canManage: false });

  it('renders without throwing', () => {
    expect(() => html()).not.toThrow();
  });

  it('keeps the contact columns — those follow the role, not the prefix', () => {
    expect(html()).toContain('School ID');
    expect(html()).toContain('ada@school.test');
    expect(html()).toContain('F00123');
  });

  it('renders no control that would post or navigate to a missing target', () => {
    expect(html()).not.toContain('View as');
    expect(html()).not.toContain('Remove');
    expect(html()).not.toContain('data-testid="table-action-view"');
  });
});
