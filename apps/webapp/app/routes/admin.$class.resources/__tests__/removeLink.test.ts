import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The linking itself now lives in ClassmojiService.resourceLink (shared with the
 * MCP resource-link tools), so this suite pins what the ROUTE still owns:
 *
 * - `linkId` / `resourceId` / `targetId` arrive in an untyped JSON body. Prisma
 *   drops an `undefined` value from a `where` and its id fields also accept a
 *   `StringFilter` object, either of which would leave the service's compound
 *   `where` matching every link in the classroom. The route rejects those with
 *   a 400 and the service is never reached.
 * - The classroom the service is called with is the AUTHORIZED one, never
 *   anything from the request body.
 * - The service's typed failures map back onto the responses this route has
 *   always sent.
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
    const res = (await removeLink({ linkId, resourceType: 'page' }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    expect(removeLinkService).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a slide linkId without deleting', async (_l, linkId) => {
    const res = (await removeLink({ linkId, resourceType: 'slide' }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    expect(removeLinkService).not.toHaveBeenCalled();
  });

  it('removes a real page link through the service, scoped to the authorized classroom', async () => {
    removeLinkService.mockResolvedValue({ id: 'link-1', resourceType: 'page' });

    await expect(removeLink({ linkId: 'link-1', resourceType: 'page' })).resolves.toEqual({
      success: true,
    });
    // classroomId is the AUTHORIZED classroom, never request-body input.
    expect(removeLinkService).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'classroom-1',
      resourceType: 'page',
      linkId: 'link-1',
    });
  });

  it('treats any non-page resourceType as a slide rather than passing it through', async () => {
    removeLinkService.mockResolvedValue({ id: 'link-1', resourceType: 'slide' });

    await removeLink({ linkId: 'link-1', resourceType: { not: '' } });

    expect(removeLinkService).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'slide' })
    );
  });

  it('reports a link that was not this classroom as a 404', async () => {
    // The service's deleteMany matched nothing, so nothing was deleted and the
    // manifest was left alone — the route just relays that.
    removeLinkService.mockRejectedValue(
      new ResourceLinkServiceError('link_not_found', 'not found')
    );

    const res = (await removeLink({ linkId: 'link-1', resourceType: 'slide' }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe('Link not found in classroom');
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
    const res = (await submit('addLink', { ...BODY, resourceId }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res.status).toBe(400);
    expect(addLink).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a targetId without linking', async (_l, targetId) => {
    const res = (await submit('addLink', { ...BODY, targetId }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res.status).toBe(400);
    expect(addLink).not.toHaveBeenCalled();
  });

  it('links through the service using the authorized classroom', async () => {
    addLink.mockResolvedValue({ id: 'link-1' });

    await expect(submit('addLink', BODY)).resolves.toEqual({ success: true });
    expect(addLink).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'classroom-1',
      resourceType: 'page',
      resourceId: 'page-1',
      targetType: 'repository',
      targetId: 'repo-1',
    });
  });

  const errorCases = [
    ['resource_not_found', 404, 'Page not found in classroom'],
    ['target_not_found', 404, 'Repository not found in classroom'],
    ['already_linked', 409, 'Already linked'],
  ] as const;

  it.each(errorCases)('maps %s onto the route response', async (code, status, text) => {
    addLink.mockRejectedValue(new ResourceLinkServiceError(code, 'nope'));

    const res = (await submit('addLink', BODY).catch((e: unknown) => e)) as Response;

    expect(res.status).toBe(status);
    await expect(res.text()).resolves.toBe(text);
  });

  it('names the slide/assignment halves of the not-found responses', async () => {
    addLink.mockRejectedValue(new ResourceLinkServiceError('target_not_found', 'nope'));

    const res = (await submit('addLink', {
      ...BODY,
      resourceType: 'slide',
      targetType: 'assignment',
    }).catch((e: unknown) => e)) as Response;

    await expect(res.text()).resolves.toBe('Assignment not found in classroom');
  });
});
