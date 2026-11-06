/**
 * The capability a loader hands an editor, and the repository-write check.
 *
 * `media` must be null unless all three hold — Pro, a bucket on this
 * deployment, a classroom whose content can be served — because an editor that
 * saw a non-null `media` would send videos somewhere they could never be shown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  getProStateForClassroomId: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...a: unknown[]) => mocks.findUnique(...a) },
    mediaObject: { findMany: (...a: unknown[]) => mocks.findMany(...a) },
  }),
}));

vi.mock('../../classmoji/subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => mocks.getProStateForClassroomId(...a),
}));

const { assertRepoTarget, uploadCapabilityFor } = await import('../uploadCapability.ts');
const { isMediaRoutingError, mediaRoutingResponse } = await import('../MediaRoutingError.ts');

const MB = 1024 * 1024;
const GIB = 1024 * MB;

/** A classroom the delivery layer can serve, with every field present. */
const deliverable = {
  id: 'class-1',
  content_delivery_enabled: true,
  content_repo: 'content-repo',
  git_organization: { login: 'org', provider: 'GITHUB', github_installation_id: '42' },
};

function configureMedia(on: boolean) {
  for (const name of [
    'MEDIA_R2_ACCOUNT_ID',
    'MEDIA_R2_ACCESS_KEY_ID',
    'MEDIA_R2_SECRET_ACCESS_KEY',
    'MEDIA_R2_BUCKET',
  ]) {
    if (on) process.env[name] = 'x';
    else delete process.env[name];
  }
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  configureMedia(true);
  process.env.CONTENT_SIGNING_SECRET = 'secret';
  process.env.CONTENT_DELIVERY_ORIGIN = 'https://content.test';
  mocks.getProStateForClassroomId.mockResolvedValue({ isPro: true });
  mocks.findMany.mockResolvedValue([]);
});

describe('uploadCapabilityFor', () => {
  it('gives a Pro classroom that can deliver its media, with what is left', async () => {
    mocks.findMany.mockResolvedValue([
      { size_bytes: BigInt(3 * GIB), rendition_bytes: null, original_deleted_at: null },
    ]);
    await expect(uploadCapabilityFor(deliverable)).resolves.toEqual({
      repoMaxBytes: 35 * MB,
      repoFileTypes: 'any',
      isPro: true,
      media: { perFileMaxBytes: 2_000_000_000, remainingBytes: 7 * GIB },
    });
  });

  it('gives a free classroom no media', async () => {
    mocks.getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(uploadCapabilityFor(deliverable)).resolves.toMatchObject({
      isPro: false,
      media: null,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('gives no media where the deployment has no bucket', async () => {
    configureMedia(false);
    await expect(uploadCapabilityFor(deliverable)).resolves.toMatchObject({
      isPro: true,
      media: null,
    });
  });

  it('gives no media where the deployment has a bucket but cannot sign delivery URLs', async () => {
    // Media is only ever served signed. R2 credentials without the signing
    // secret (or the delivery origin) would take uploads nothing can show.
    delete process.env.CONTENT_SIGNING_SECRET;
    await expect(uploadCapabilityFor(deliverable)).resolves.toMatchObject({
      isPro: true,
      repoFileTypes: 'allowlist',
      media: null,
    });
    process.env.CONTENT_SIGNING_SECRET = 'secret';
    delete process.env.CONTENT_DELIVERY_ORIGIN;
    await expect(uploadCapabilityFor(deliverable)).resolves.toMatchObject({ media: null });
  });

  it('gives no media to a classroom that cannot deliver, and keeps its allowlist', async () => {
    await expect(
      uploadCapabilityFor({ ...deliverable, content_delivery_enabled: false })
    ).resolves.toMatchObject({ media: null, repoFileTypes: 'allowlist' });
  });

  it('reads the delivery fields a caller did not bring, rather than guessing', async () => {
    mocks.findUnique.mockResolvedValue({
      content_delivery_enabled: true,
      content_repo: 'content-repo',
      git_organization: deliverable.git_organization,
    });
    const capability = await uploadCapabilityFor({ id: 'class-1' });
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'class-1' } })
    );
    expect(capability.media).not.toBeNull();
  });

  it('reads the GitLab connection when building a media capability', async () => {
    mocks.findUnique.mockImplementation(async ({ select }) => ({
      content_delivery_enabled: true,
      content_repo: 'content-repo',
      git_organization: {
        login: 'org',
        provider: 'GITLAB',
        ...(select.git_organization.select.gitlab_connection_id
          ? { gitlab_connection_id: 'connection' }
          : {}),
      },
    }));
    expect((await uploadCapabilityFor({ id: 'class-1' })).media).not.toBeNull();
  });

  it('never reports negative space', async () => {
    mocks.findMany.mockResolvedValue([
      { size_bytes: BigInt(11 * GIB), rendition_bytes: null, original_deleted_at: null },
    ]);
    const capability = await uploadCapabilityFor(deliverable);
    expect(capability.media?.remainingBytes).toBe(0);
  });
});

describe('assertRepoTarget', () => {
  it('refuses a Pro video with USE_MEDIA', async () => {
    const thrown = await assertRepoTarget(deliverable, { name: 'intro.mp4', size: MB }).catch(
      error => error
    );
    expect(isMediaRoutingError(thrown)).toBe(true);
    expect(thrown.code).toBe('USE_MEDIA');

    const response = mediaRoutingResponse(thrown)!;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'USE_MEDIA' });
  });

  it('refuses a Pro file over the repository cap with USE_MEDIA', async () => {
    await expect(
      assertRepoTarget(deliverable, { name: 'big.pdf', size: 36 * MB })
    ).rejects.toMatchObject({ code: 'USE_MEDIA' });
  });

  it('lets a small non-video file through without a single lookup', async () => {
    await expect(
      assertRepoTarget(deliverable, { name: 'diagram.png', size: MB })
    ).resolves.toBeUndefined();
    expect(mocks.getProStateForClassroomId).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('lets a free classroom’s video through to the repository', async () => {
    mocks.getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(
      assertRepoTarget(deliverable, { name: 'intro.mp4', size: MB })
    ).resolves.toBeUndefined();
  });

  it('never sums the quota — routing does not read it', async () => {
    await assertRepoTarget(deliverable, { name: 'intro.mp4', size: MB }).catch(() => {});
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('leaves a file too large for anything to the repository write’s own refusal', async () => {
    mocks.getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(
      assertRepoTarget(deliverable, { name: 'big.pdf', size: 60 * MB })
    ).resolves.toBeUndefined();
  });
});

describe('mediaRoutingResponse', () => {
  it('is null for anything that is not a routing refusal', () => {
    expect(mediaRoutingResponse(new Error('x'))).toBeNull();
    expect(mediaRoutingResponse(Object.assign(new Error('x'), { status: 409 }))).toBeNull();
  });
});
