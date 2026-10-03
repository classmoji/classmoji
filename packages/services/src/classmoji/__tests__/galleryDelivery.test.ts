import { beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn(), resolve: vi.fn() }));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    formResponse: { findFirst: mocks.findFirst },
    mediaObject: { findMany: mocks.findMany },
  }),
}));
vi.mock('../contentDelivery.service.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../contentDelivery.service.ts')>()),
  canonicalizeMany: async (_ctx: unknown, refs: string[]) => new Map(refs.map(ref => [ref, ref])),
  resolveDelivery: mocks.resolve,
}));
import { getForOrg } from '../gallery.service.ts';

const mediaId = randomUUID();
const fieldId = randomUUID();
const sourceId = randomUUID();
const response = {
  id: randomUUID(),
  form_id: randomUUID(),
  user_id: randomUUID(),
  submitted_at: new Date(),
  answers: { [fieldId]: `media://${mediaId}` },
  revision: {
    fields: {
      definition_version: 1,
      fields: [{ id: fieldId, type: 'short_text', label: 'Cover', gallery_role: 'cover' }],
    },
  },
  form: {
    classroom: {
      id: sourceId,
      name: 'Old term',
      slug: 'old-term',
      created_at: new Date(),
      content_repo: 'old-content',
      content_key_version: 2,
      content_delivery_enabled: true,
      git_organization: { login: 'old-org' },
    },
  },
};
const media = {
  id: mediaId,
  uploaded_by: response.user_id,
  gallery_form_id: response.form_id,
  gallery_field_id: fieldId,
  kind: 'IMAGE',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue(response);
  mocks.findMany.mockResolvedValue([media]);
  mocks.resolve.mockImplementation(async (_ctx, refs: string[]) => ({
    urls: new Map(refs.map(ref => [ref, 'https://content.test/fresh-signed-cover'])),
  }));
});

describe('public gallery media delivery', () => {
  it('signs approved media against its original classroom across terms', async () => {
    expect((await getForOrg('org', response.id))?.coverUrl).toBe(
      'https://content.test/fresh-signed-cover'
    );
    expect(mocks.resolve.mock.calls[0][0].classroom.id).toBe(sourceId);
    expect(mocks.findMany.mock.calls[0][0].where).toMatchObject({
      classroom_id: sourceId,
      status: 'READY',
    });
  });

  it.each(['uploaded_by', 'gallery_form_id', 'gallery_field_id', 'kind'])(
    'does not sign a reference with mismatched %s',
    async key => {
      mocks.findMany.mockResolvedValue([{ ...media, [key]: 'foreign' }]);
      expect((await getForOrg('org', response.id))?.coverUrl).toBeNull();
      expect(mocks.resolve.mock.calls[0][1]).toEqual([]);
    }
  );

  it('keeps the gallery usable when hosted media cannot be resolved', async () => {
    mocks.resolve.mockRejectedValue(new Error('delivery unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await getForOrg('org', response.id)).toMatchObject({
        title: 'Untitled project',
        coverUrl: null,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
