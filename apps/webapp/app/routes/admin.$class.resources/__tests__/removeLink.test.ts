import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The linking itself now lives in ClassmojiService.resourceLink (shared with the
 * MCP resource-link tools), so this suite pins what the ROUTE still owns:
 *
 * - `linkId` / `resourceId` / `targetId` arrive in an untyped JSON body. Prisma
 *   drops an `undefined` value from a `where` and its id fields also accept a
 *   `StringFilter` object, either of which would leave the service's compound
 *   `where` matching every link in the classroom. The route rejects those and
 *   the service is never reached.
 * - The classroom the service is called with is the AUTHORIZED one, never
 *   anything from the request body.
 * - The service's typed failures come back as RETURNED `{ error }` payloads,
 *   which is what puts them in `fetcher.data` for the kanban's callout instead
 *   of in the root error boundary — and what leaves React Router free to
 *   revalidate the board afterwards. A thrown Response would do neither.
 *
 * Driven directly, like the api.quiz gating test: the auth seam and the service
 * are mocked, so the assertion is that the mutation is never ISSUED.
 */

const addLink = vi.fn();
const removeLinkService = vi.fn();

vi.mock('@classmoji/services', () => {
  // The route branches on `instanceof`, so the class it imports must be the
  // class this test throws.
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
        addLink: (...a: unknown[]) => addLink(...a),
        removeLink: (...a: unknown[]) => removeLinkService(...a),
      },
    },
  };
});

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(async () => ({
    classroom: { id: 'classroom-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  })),
  assertClassroomMutationAllowed: vi.fn(),
}));

const { ResourceLinkServiceError } = await import('@classmoji/services');
const { action } = await import('../action.ts');

const submit = (intent: 'addLink' | 'removeLink', body: unknown) =>
  action({
    request: new Request(`http://localhost/admin/cs52/resources?/${intent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: { class: 'cs52' },
    context: {},
  } as never);

const removeLink = (body: unknown) => submit('removeLink', body);

/** Values that survive `if (!id)` but widen a scoped `where`. */
const unusableIds: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a StringFilter object', { not: '' }],
  ['a number', 7],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin.$class.resources removeLink', () => {
  it.each(unusableIds)('rejects %s as a page linkId without deleting', async (_l, linkId) => {
    await expect(removeLink({ linkId, resourceType: 'page' })).resolves.toEqual({
      error: 'Invalid link id',
    });
    expect(removeLinkService).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a slide linkId without deleting', async (_l, linkId) => {
    await expect(removeLink({ linkId, resourceType: 'slide' })).resolves.toEqual({
      error: 'Invalid link id',
    });
    expect(removeLinkService).not.toHaveBeenCalled();
  });

  it('removes a real page link through the service, scoped to the authorized classroom', async () => {
    removeLinkService.mockResolvedValue({
      id: 'link-1',
      resourceType: 'page',
      manifestSynced: true,
    });

    await expect(removeLink({ linkId: 'link-1', resourceType: 'page' })).resolves.toEqual({
      success: true,
      manifest_synced: true,
    });
    // classroomId is the AUTHORIZED classroom, never request-body input.
    expect(removeLinkService).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'classroom-1',
      resourceType: 'page',
      linkId: 'link-1',
    });
  });

  it('relays a manifest push that did not land rather than reporting a plain success', async () => {
    removeLinkService.mockResolvedValue({
      id: 'link-1',
      resourceType: 'page',
      manifestSynced: false,
    });

    await expect(removeLink({ linkId: 'link-1', resourceType: 'page' })).resolves.toEqual({
      success: true,
      manifest_synced: false,
    });
  });

  it('treats any non-page resourceType as a slide rather than passing it through', async () => {
    removeLinkService.mockResolvedValue({
      id: 'link-1',
      resourceType: 'slide',
      manifestSynced: true,
    });

    await removeLink({ linkId: 'link-1', resourceType: { not: '' } });

    expect(removeLinkService).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'slide' })
    );
  });

  it('returns a link that was not this classroom as an error payload, not a thrown response', async () => {
    // The service's deleteMany matched nothing, so nothing was deleted and the
    // manifest was left alone — the route relays that into fetcher.data, where
    // the kanban can show it without the page being replaced by a boundary.
    removeLinkService.mockRejectedValue(
      new ResourceLinkServiceError('link_not_found', 'not found')
    );

    await expect(removeLink({ linkId: 'link-1', resourceType: 'slide' })).resolves.toEqual({
      error: 'Link not found in classroom',
    });
  });
});

describe('admin.$class.resources addLink', () => {
  const BODY = {
    resourceId: 'page-1',
    resourceType: 'page',
    targetType: 'repository',
    targetId: 'repo-1',
  };

  it.each(unusableIds)('rejects %s as a resourceId without linking', async (_l, resourceId) => {
    await expect(submit('addLink', { ...BODY, resourceId })).resolves.toEqual({
      error: 'Invalid resource id',
    });
    expect(addLink).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a targetId without linking', async (_l, targetId) => {
    await expect(submit('addLink', { ...BODY, targetId })).resolves.toEqual({
      error: 'Invalid target id',
    });
    expect(addLink).not.toHaveBeenCalled();
  });

  it('links through the service using the authorized classroom', async () => {
    addLink.mockResolvedValue({ id: 'link-1', manifestSynced: true });

    await expect(submit('addLink', BODY)).resolves.toEqual({
      success: true,
      manifest_synced: true,
    });
    expect(addLink).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'classroom-1',
      resourceType: 'page',
      resourceId: 'page-1',
      targetType: 'repository',
      targetId: 'repo-1',
    });
  });

  it('relays a manifest push that did not land rather than reporting a plain success', async () => {
    addLink.mockResolvedValue({ id: 'link-1', manifestSynced: false });

    await expect(submit('addLink', BODY)).resolves.toEqual({
      success: true,
      manifest_synced: false,
    });
  });

  const errorCases = [
    ['resource_not_found', 'Page not found in classroom'],
    ['target_not_found', 'Repository not found in classroom'],
    ['already_linked', 'Already linked'],
  ] as const;

  it.each(errorCases)('returns %s as an error payload the fetcher can read', async (code, text) => {
    // Returned, not thrown: a thrown Response never reaches fetcher.data, and a
    // 4xx would also stop React Router revalidating the board — which is what
    // clears the stale card behind an "Already linked" rejection.
    addLink.mockRejectedValue(new ResourceLinkServiceError(code, 'nope'));

    await expect(submit('addLink', BODY)).resolves.toEqual({ error: text });
  });

  it('names the slide/assignment halves of the not-found messages', async () => {
    addLink.mockRejectedValue(new ResourceLinkServiceError('target_not_found', 'nope'));

    await expect(
      submit('addLink', { ...BODY, resourceType: 'slide', targetType: 'assignment' })
    ).resolves.toEqual({ error: 'Assignment not found in classroom' });
  });

  it('lets a code it has no phrasing for reach the error boundary', async () => {
    // Only failures this route can explain are turned into user-facing copy; an
    // unrecognised one is a bug, not a message, so it is not swallowed.
    const futureCode = 'something_new' as ConstructorParameters<typeof ResourceLinkServiceError>[0];
    addLink.mockRejectedValue(new ResourceLinkServiceError(futureCode, 'nope'));

    await expect(submit('addLink', BODY)).rejects.toBeInstanceOf(ResourceLinkServiceError);
  });

  it('lets an unrelated failure through untouched', async () => {
    addLink.mockRejectedValue(new Error('connection lost'));

    await expect(submit('addLink', BODY)).rejects.toThrow('connection lost');
  });
});
