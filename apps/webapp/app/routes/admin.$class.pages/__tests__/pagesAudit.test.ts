/**
 * Unit tests for the admin pages action.
 *
 * Two properties, and they hold each other up:
 *
 * 1. Every mutation records an audit row. This surface wrote none, while the
 *    MCP page tools have always audited theirs; the rows here are shaped to
 *    match — resource_type 'PAGES', the page id, CREATE/UPDATE/DELETE — so both
 *    surfaces can be queried together. `tool` distinguishes the intents, which
 *    is also what stops the audit service's 5-second dedup from folding a
 *    status change and a menu toggle on the same page into a single row.
 *
 * 2. Each write is bound to `{ id, classroom_id }` and only counts when it
 *    matched one row. Authorization binds to the classroom in the URL but
 *    `pageId` arrives in the form body, so without that the two are unrelated —
 *    and an audit row naming the authorized classroom would then be describing
 *    a write that landed somewhere else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  findById: vi.fn(),
  deletePage: vi.fn(),
  findByClassroomId: vi.fn(),
  getRecentViewersForPaths: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: {
      findById: (...a: unknown[]) => mocks.findById(...a),
      deletePage: (...a: unknown[]) => mocks.deletePage(...a),
      findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a),
    },
    resourceView: {
      getRecentViewersForPaths: (...a: unknown[]) => mocks.getRecentViewersForPaths(...a),
    },
  },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ page: { updateMany: (...a: unknown[]) => mocks.updateMany(...a) } }),
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/components', () => ({ TableActionButtons: () => null, RecentViewers: () => null }));
vi.mock('antd', () => ({
  Table: () => null,
  Button: () => null,
  Input: () => null,
  Select: () => null,
  Switch: () => null,
  Tooltip: () => null,
}));
vi.mock('@tabler/icons-react', () => ({
  IconPlus: () => null,
  IconEyeOff: () => null,
  IconLock: () => null,
  IconWorld: () => null,
  IconMenu2: () => null,
  IconSearch: () => null,
}));
vi.mock('react-router', () => ({
  useFetcher: () => ({ submit: vi.fn() }),
  Link: () => null,
  Outlet: () => null,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/admin/cs52-26f/pages' }),
}));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_PAGE = 'page-in-this-classroom';
const FOREIGN_PAGE = 'page-in-another-classroom';

const actionArgs = (body: Record<string, string>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.append(key, value);
  return {
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/pages`, {
      method: 'POST',
      body: formData,
    }),
  } as unknown as Parameters<typeof route.action>[0];
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.findById.mockResolvedValue({
    id: OWN_PAGE,
    classroom_id: 'class-1',
    title: 'Syllabus',
  });
  mocks.deletePage.mockResolvedValue({ success: true });
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe('pages action — audit rows', () => {
  it('audits a delete against the page that was removed', async () => {
    const result = await route.action(actionArgs({ intent: 'delete', pageId: OWN_PAGE }));

    expect(result).toEqual({ success: true, intent: 'delete' });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'DELETE',
      resourceType: 'PAGES',
      resourceId: OWN_PAGE,
      metadata: { tool: 'web:pages.delete', title: 'Syllabus' },
    });
  });

  it('audits a status change with the flag pair it wrote', async () => {
    const result = await route.action(
      actionArgs({ pageId: OWN_PAGE, field: 'status', value: 'public' })
    );

    expect(result).toEqual({ success: true });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'PAGES',
        resourceId: OWN_PAGE,
        metadata: {
          tool: 'web:pages.status',
          field: 'status',
          value: 'public',
          is_draft: false,
          is_public: true,
        },
      })
    );
  });

  it('audits the student-menu toggle with the boolean it wrote', async () => {
    await route.action(
      actionArgs({ pageId: OWN_PAGE, field: 'show_in_student_menu', value: 'false' })
    );

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceId: OWN_PAGE,
        metadata: {
          tool: 'web:pages.show_in_student_menu',
          field: 'show_in_student_menu',
          // "false" read as a boolean, not as a truthy string.
          value: false,
        },
      })
    );
  });

  it('gives the two update intents distinct tool names so neither is deduped away', async () => {
    await route.action(actionArgs({ pageId: OWN_PAGE, field: 'status', value: 'draft' }));
    await route.action(
      actionArgs({ pageId: OWN_PAGE, field: 'show_in_student_menu', value: 'true' })
    );

    const tools = mocks.addClassroomAuditLog.mock.calls.map(
      ([entry]) => (entry as { metadata: { tool: string } }).metadata.tool
    );
    expect(new Set(tools).size).toBe(2);
  });
});

describe('pages action — writes stay inside the authorized classroom', () => {
  it('binds a status update to the classroom and audits nothing when it matches no row', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await route.action(
      actionArgs({ pageId: FOREIGN_PAGE, field: 'status', value: 'public' })
    );

    expect(result).toEqual({ error: 'Page not found' });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: FOREIGN_PAGE, classroom_id: 'class-1' } })
    );
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses to delete a page belonging to another classroom', async () => {
    // deletePage() resolves the page by id alone, so the classroom is proved
    // before it is ever called.
    mocks.findById.mockResolvedValue({ id: FOREIGN_PAGE, classroom_id: 'other-class' });

    const result = await route.action(actionArgs({ intent: 'delete', pageId: FOREIGN_PAGE }));

    expect(result).toEqual({ error: 'Page not found' });
    expect(mocks.deletePage).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses to delete a page that does not exist', async () => {
    mocks.findById.mockResolvedValue(null);

    await expect(route.action(actionArgs({ intent: 'delete', pageId: 'nope' }))).resolves.toEqual({
      error: 'Page not found',
    });
    expect(mocks.deletePage).not.toHaveBeenCalled();
  });

  it('does not write or audit when the authorization gate throws', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(
      route.action(actionArgs({ pageId: OWN_PAGE, field: 'status', value: 'public' }))
    ).rejects.toBeInstanceOf(Response);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});
