/**
 * form_gallery_queue / form_gallery_moderate: the teaching team's gallery
 * moderation, scoped to the authorized classroom's own gallery forms.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  formFindById: vi.fn(),
  queueForForm: vi.fn(),
  setStatuses: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    form: { findById: (...a: unknown[]) => mocks.formFindById(...a) },
    gallery: {
      queueForForm: (...a: unknown[]) => mocks.queueForForm(...a),
      setStatuses: (...a: unknown[]) => mocks.setStatuses(...a),
      GALLERY_MODERATION_MAX: 200,
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { formGalleryQueueTool, formGalleryModerateTool } = await import('../gallery.ts');

/** An ASSISTANT authorized in `class-1`: moderation is TA work. */
const CTX: ToolContext = {
  viewer: { userId: 'ta-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'ASSISTANT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'ASSISTANT' },
    classroom: { slug: 'w26', settings: {} },
  },
} as unknown as ToolContext;

const FORM_ID = '11111111-1111-4111-8111-111111111111';
const RESPONSE_ID = '22222222-2222-4222-8222-222222222222';
const GALLERY_FORM = { id: FORM_ID, classroom_id: 'class-1', gallery_org_id: 'org-1' };
const SEEN = '2026-10-20T12:00:00.000Z';

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.formFindById.mockResolvedValue(GALLERY_FORM);
  mocks.queueForForm.mockResolvedValue([
    { id: RESPONSE_ID, title: 'Trail Buddy', galleryStatus: 'PENDING', updatedAt: SEEN },
  ]);
  mocks.setStatuses.mockResolvedValue({ updated: 1, stale: [] });
});

describe('form_gallery_queue', () => {
  const ARGS = { classroom: 'org/w26', form_id: FORM_ID };

  it('lists titles and statuses only, for the teaching team, as an audited read', async () => {
    const payload = parse(await formGalleryQueueTool.handler(ARGS, CTX));

    expect(mocks.queueForForm).toHaveBeenCalledWith(FORM_ID);
    expect(payload).toEqual({
      form_id: FORM_ID,
      projects: [
        {
          response_id: RESPONSE_ID,
          title: 'Trail Buddy',
          gallery_status: 'PENDING',
          updated_at: SEEN,
        },
      ],
    });
    expect(formGalleryQueueTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(formGalleryQueueTool.auditRead?.resourceType).toBe('FORMS');
  });

  it('answers a form of another classroom like a missing one', async () => {
    mocks.formFindById.mockResolvedValue({ ...GALLERY_FORM, classroom_id: 'class-2' });

    await expect(formGalleryQueueTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.queueForForm).not.toHaveBeenCalled();
  });

  it('answers a form that does not feed the gallery like a missing one', async () => {
    mocks.formFindById.mockResolvedValue({ ...GALLERY_FORM, gallery_org_id: null });

    await expect(formGalleryQueueTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.queueForForm).not.toHaveBeenCalled();
  });
});

describe('form_gallery_moderate', () => {
  const ARGS = {
    classroom: 'org/w26',
    form_id: FORM_ID,
    responses: [{ response_id: RESPONSE_ID, updated_at: SEEN }],
    status: 'APPROVED' as const,
  };

  it('moderates inside the authorized form and audits as the caller, in one write', async () => {
    const payload = parse(await formGalleryModerateTool.handler(ARGS, CTX));

    expect(payload).toEqual({ success: true, updated: 1, gallery_status: 'APPROVED' });
    expect(mocks.setStatuses).toHaveBeenCalledWith({
      formId: FORM_ID,
      responseIds: [RESPONSE_ID],
      status: 'APPROVED',
      versions: { [RESPONSE_ID]: SEEN },
      audit: {
        user_id: 'ta-1',
        classroom_id: 'class-1',
        role: 'ASSISTANT',
        resource_type: 'FORMS',
        data: {
          tool: 'forms.responses.gallery_status',
          via: 'mcp',
          mcp_tool: 'form_gallery_moderate',
        },
      },
    });
  });

  it('records the impersonating admin on the audit rows', async () => {
    const ctx = {
      ...CTX,
      viewer: { ...CTX.viewer, impersonatedBy: 'admin-1' },
    } as unknown as ToolContext;

    await formGalleryModerateTool.handler(ARGS, ctx);

    expect(mocks.setStatuses.mock.calls[0][0].audit.data).toMatchObject({
      impersonated_by: 'admin-1',
    });
  });

  it('never touches a form of another classroom', async () => {
    mocks.formFindById.mockResolvedValue({ ...GALLERY_FORM, classroom_id: 'class-2' });

    await expect(formGalleryModerateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.setStatuses).not.toHaveBeenCalled();
  });

  it('reports a response edited since the queue was read, unapproved', async () => {
    mocks.setStatuses.mockResolvedValue({ updated: 0, stale: [RESPONSE_ID] });

    const payload = parse(await formGalleryModerateTool.handler(ARGS, CTX));

    expect(payload).toMatchObject({ success: false, updated: 0, stale: [RESPONSE_ID] });
  });

  it('says so when no submitted response of the form matched', async () => {
    mocks.setStatuses.mockResolvedValue({ updated: 0, stale: [] });

    await expect(formGalleryModerateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
  });

  it('asks for confirmation: approving publishes to the open web', () => {
    expect(formGalleryModerateTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(formGalleryModerateTool.annotations).toEqual({
      destructive: true,
      idempotent: true,
      openWorld: true,
    });
  });
});
