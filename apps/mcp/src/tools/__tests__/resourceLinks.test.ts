/**
 * Unit tests for resource_link_add / resource_link_remove / resource_links_list.
 *
 * Security focus: the classroomId handed to every service call comes from the
 * ToolContext, never from args; the service's caller-fixable failures map onto
 * the right ToolError kinds (an unknown id and another classroom's record are
 * the SAME scopedNotFound, so a probe cannot enumerate foreign pages, decks,
 * repos or assignments); no mutation is left un-audited; and no raw service row
 * reaches the caller — every response field is allow-listed.
 *
 * `@classmoji/services` is mocked (factory idiom) INCLUDING
 * ResourceLinkServiceError, so the handlers' `instanceof` mapping runs against
 * the same class the test throws — no database and no manifest pushes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  addLink: vi.fn(),
  removeLink: vi.fn(),
  listLinks: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => {
  // Same shape as the real service error; the tools branch on `instanceof`, so
  // the class the handler imports must be the class the test constructs.
  class ResourceLinkServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'ResourceLinkServiceError';
      this.code = code;
    }
  }
  return {
    ResourceLinkServiceError,
    ClassmojiService: {
      resourceLink: {
        addLink: (...a: unknown[]) => mocks.addLink(...a),
        removeLink: (...a: unknown[]) => mocks.removeLink(...a),
        listLinks: (...a: unknown[]) => mocks.listLinks(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const { ResourceLinkServiceError } = await import('@classmoji/services');
const { resourceLinkAddTool, resourceLinkRemoveTool, resourceLinksListTool } =
  await import('../resourceLinks.ts');

const CTX: ToolContext = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const CREATED_AT = new Date('2026-01-02T03:04:05.000Z');

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** The audit row the handler wrote (first call). */
function auditRow() {
  return mocks.auditCreate.mock.calls[0][0] as {
    action: string;
    classroom_id: string;
    resource_type: string;
    resource_id?: string | null;
    data: Record<string, unknown>;
  };
}

/** Run a handler and hand back whatever it threw. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e as { kind?: string; message?: string }
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('resource_link_add', () => {
  const ARGS = {
    classroom: 'org/w26',
    resource_type: 'page' as const,
    resource_id: 'page-1',
    target_type: 'repository' as const,
    target_id: 'repo-1',
  };
  const LINK = {
    id: 'link-1',
    resourceType: 'page',
    resourceId: 'page-1',
    targetType: 'repository',
    targetId: 'repo-1',
    order: 0,
    createdAt: CREATED_AT,
  };

  it('links through the service using the ctx classroomId and audits the write', async () => {
    mocks.addLink.mockResolvedValue(LINK);

    const result = parse(await resourceLinkAddTool.handler(ARGS, CTX));

    // classroomId is the AUTHORIZED classroom, never an arg.
    expect(mocks.addLink).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      resourceType: 'page',
      resourceId: 'page-1',
      targetType: 'repository',
      targetId: 'repo-1',
    });
    expect(result).toMatchObject({
      success: true,
      link_id: 'link-1',
      resource_type: 'page',
      resource_id: 'page-1',
      target_type: 'repository',
      target_id: 'repo-1',
      order: 0,
      created_at: '2026-01-02T03:04:05.000Z',
    });

    const audit = auditRow();
    expect(audit).toMatchObject({
      action: 'CREATE',
      classroom_id: 'class-1',
      resource_type: 'RESOURCES',
      // The LINK id — it is what keeps back-to-back links as separate rows.
      resource_id: 'link-1',
    });
    expect(audit.data).toMatchObject({ tool: 'resource_link_add', link_id: 'link-1' });
  });

  it('does not leak raw service fields into the response', async () => {
    mocks.addLink.mockResolvedValue({ ...LINK, page_id: 'page-1', internal_note: 'secret' });

    const result = parse(await resourceLinkAddTool.handler(ARGS, CTX));

    expect(Object.keys(result).sort()).toEqual([
      'created_at',
      'link_id',
      'message',
      'order',
      'resource_id',
      'resource_type',
      'success',
      'target_id',
      'target_type',
    ]);
  });

  it.each([
    ['page', 'Page'],
    ['slide', 'Slide'],
  ])(
    'reports a foreign %s as the uniform scoped not_found, un-audited',
    async (resourceType, label) => {
      mocks.addLink.mockRejectedValue(new ResourceLinkServiceError('resource_not_found', 'nope'));

      const error = await failure(
        resourceLinkAddTool.handler(
          { ...ARGS, resource_type: resourceType as 'page' | 'slide' },
          CTX
        )
      );

      expect(error?.kind).toBe('not_found');
      expect(error?.message).toBe(`${label} not found in this classroom`);
      // Nothing was written, so nothing may be audited.
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['repository', 'Repository'],
    ['assignment', 'Assignment'],
  ])('reports a foreign %s target as the uniform scoped not_found', async (targetType, label) => {
    mocks.addLink.mockRejectedValue(new ResourceLinkServiceError('target_not_found', 'nope'));

    const error = await failure(
      resourceLinkAddTool.handler(
        { ...ARGS, target_type: targetType as 'repository' | 'assignment' },
        CTX
      )
    );

    expect(error?.kind).toBe('not_found');
    expect(error?.message).toBe(`${label} not found in this classroom`);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports an existing link as invalid_params rather than a missing record', async () => {
    mocks.addLink.mockRejectedValue(new ResourceLinkServiceError('already_linked', 'dupe'));

    const error = await failure(resourceLinkAddTool.handler(ARGS, CTX));

    expect(error?.kind).toBe('invalid_params');
    expect(error?.message).toContain('already linked');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown resource_type at the schema before the service is reached', () => {
    expect(resourceLinkAddTool.inputSchema.resource_type.safeParse('quiz').success).toBe(false);
    expect(resourceLinkAddTool.inputSchema.target_type.safeParse('module').success).toBe(false);
    expect(mocks.addLink).not.toHaveBeenCalled();
  });

  it('is a non-destructive, outward-reaching OWNER/TEACHER write', () => {
    expect(resourceLinkAddTool.scope).toBe('write');
    // The web resources kanban is ['OWNER','TEACHER'] — ASSISTANT is excluded.
    expect(resourceLinkAddTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(resourceLinkAddTool.annotations).toEqual({ destructive: false, openWorld: true });
  });
});

describe('resource_link_remove', () => {
  const ARGS = { classroom: 'org/w26', resource_type: 'slide' as const, link_id: 'link-9' };

  it('removes through the service using the ctx classroomId and audits the delete', async () => {
    mocks.removeLink.mockResolvedValue({ id: 'link-9', resourceType: 'slide' });

    const result = parse(await resourceLinkRemoveTool.handler(ARGS, CTX));

    expect(mocks.removeLink).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      resourceType: 'slide',
      linkId: 'link-9',
    });
    expect(result).toMatchObject({ success: true, link_id: 'link-9', resource_type: 'slide' });

    const audit = auditRow();
    expect(audit).toMatchObject({
      action: 'DELETE',
      classroom_id: 'class-1',
      resource_type: 'RESOURCES',
      resource_id: 'link-9',
    });
    expect(audit.data).toMatchObject({ tool: 'resource_link_remove', link_id: 'link-9' });
  });

  it('reports a missing or foreign link as one uniform not_found, un-audited', async () => {
    // The service's classroom compound matched nothing — an unknown id and
    // another classroom's link are indistinguishable here by design.
    mocks.removeLink.mockRejectedValue(new ResourceLinkServiceError('link_not_found', 'nope'));

    const error = await failure(resourceLinkRemoveTool.handler(ARGS, CTX));

    expect(error?.kind).toBe('not_found');
    expect(error?.message).toBe('Link not found in this classroom');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('is explicitly non-destructive despite being a delete', () => {
    // Only the link row goes; the page/deck and repo/assignment survive and the
    // link can be recreated. The registry defaults an unset `destructive` on a
    // write to true, so this must be stated.
    expect(resourceLinkRemoveTool.scope).toBe('write');
    expect(resourceLinkRemoveTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(resourceLinkRemoveTool.annotations).toEqual({ destructive: false, openWorld: true });
  });
});

describe('resource_links_list', () => {
  const REPO_LINK = {
    id: 'link-1',
    resourceType: 'page',
    targetType: 'repository',
    order: 0,
    createdAt: CREATED_AT,
    resource: { id: 'page-1', title: 'Setup', slug: 'setup' },
    target: { id: 'repo-1', title: 'Lab 1', slug: 'lab-1' },
  };
  const ASSIGNMENT_LINK = {
    id: 'link-2',
    resourceType: 'slide',
    targetType: 'assignment',
    order: 1,
    createdAt: CREATED_AT,
    resource: { id: 'slide-1', title: 'Week 1', slug: 'week-1' },
    target: {
      id: 'assign-1',
      title: 'Part A',
      slug: 'part-a',
      repositoryId: 'repo-1',
      repositoryTitle: 'Lab 1',
    },
  };

  it('returns a counted, allow-listed list scoped to the ctx classroom', async () => {
    mocks.listLinks.mockResolvedValue([REPO_LINK, ASSIGNMENT_LINK]);

    const result = parse(await resourceLinksListTool.handler({ classroom: 'org/w26' }, CTX));

    expect(mocks.listLinks).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      resourceType: undefined,
      resourceId: undefined,
      targetType: undefined,
      targetId: undefined,
    });
    expect(result).toEqual({
      count: 2,
      links: [
        {
          id: 'link-1',
          resource_type: 'page',
          resource: { id: 'page-1', title: 'Setup', slug: 'setup' },
          target_type: 'repository',
          target: { id: 'repo-1', title: 'Lab 1', slug: 'lab-1' },
          order: 0,
          created_at: '2026-01-02T03:04:05.000Z',
        },
        {
          id: 'link-2',
          resource_type: 'slide',
          resource: { id: 'slide-1', title: 'Week 1', slug: 'week-1' },
          target_type: 'assignment',
          // An assignment target also names the repository it sits in.
          target: {
            id: 'assign-1',
            title: 'Part A',
            slug: 'part-a',
            repository_id: 'repo-1',
            repository_title: 'Lab 1',
          },
          order: 1,
          created_at: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
  });

  it('does not leak raw service fields through the summaries', async () => {
    mocks.listLinks.mockResolvedValue([
      {
        ...REPO_LINK,
        page_id: 'page-1',
        resource: { ...REPO_LINK.resource, content_path: 'secret/path.json' },
        target: { ...REPO_LINK.target, classroom_id: 'class-1' },
      },
    ]);

    const { links } = parse(await resourceLinksListTool.handler({ classroom: 'org/w26' }, CTX));

    expect(Object.keys(links[0]).sort()).toEqual([
      'created_at',
      'id',
      'order',
      'resource',
      'resource_type',
      'target',
      'target_type',
    ]);
    expect(links[0].resource).toEqual({ id: 'page-1', title: 'Setup', slug: 'setup' });
    expect(links[0].target).toEqual({ id: 'repo-1', title: 'Lab 1', slug: 'lab-1' });
  });

  it('passes every filter straight through to the service', async () => {
    mocks.listLinks.mockResolvedValue([]);

    const result = parse(
      await resourceLinksListTool.handler(
        {
          classroom: 'org/w26',
          resource_type: 'slide',
          resource_id: 'slide-1',
          target_type: 'assignment',
          target_id: 'assign-1',
        },
        CTX
      )
    );

    expect(mocks.listLinks).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      resourceType: 'slide',
      resourceId: 'slide-1',
      targetType: 'assignment',
      targetId: 'assign-1',
    });
    expect(result).toEqual({ count: 0, links: [] });
  });

  it('is a read at the OWNER/TEACHER tier and writes no audit row', async () => {
    mocks.listLinks.mockResolvedValue([]);
    await resourceLinksListTool.handler({ classroom: 'org/w26' }, CTX);

    expect(resourceLinksListTool.scope).toBe('read');
    expect(resourceLinksListTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
