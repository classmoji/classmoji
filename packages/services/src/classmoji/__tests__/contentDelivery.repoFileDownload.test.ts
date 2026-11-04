/**
 * A page's or deck's repo file → a ten-minute save-to-disk URL (MCP
 * `file_download_url`).
 *
 * The same guarantees as the FILE slide's download, with the folder as the
 * caller's claim: the `download` tier and nothing else, the filename inside the
 * signature, `delivery_off` named as itself, and a path that cannot leave the
 * folder it was asked under. The signer is real, so the URL is checked against
 * the verifier the Worker runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ensureContentAssetsOutcome = vi.fn();
const lookupContentAsset = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentAssets.service.ts', async importActual => ({
  ...(await importActual<typeof import('../contentAssets.service.ts')>()),
  ensureContentAssetsOutcome: (...args: unknown[]) => ensureContentAssetsOutcome(...args),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
}));

const { resolveRepoFileDownloadUrl, repoPathInFolder } =
  await import('../contentDelivery.service.ts');
const { verifyContentUrl } = await import('@classmoji/content-signing');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';
const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const BLOB_SHA = 'b'.repeat(40);
const FOLDER = 'pages/lab-1/assets';

const classroom = {
  id: CLASSROOM_ID,
  content_key_version: 4,
  content_repo: 'content-org-cs52',
  content_delivery_enabled: true,
  git_organization: { login: 'org' },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;
  ensureContentAssetsOutcome.mockResolvedValue({ mapIsTrustworthy: true });
  lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'blob', size: 4096 });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
  vi.restoreAllMocks();
});

describe('resolveRepoFileDownloadUrl', () => {
  it('signs the download tier, with the file name, size and expiry', async () => {
    const result = await resolveRepoFileDownloadUrl(classroom, {
      folder: FOLDER,
      path: 'pages/lab-1/assets/Übung 1.png',
    });
    expect(result).toMatchObject({
      ok: true,
      path: 'pages/lab-1/assets/Übung 1.png',
      filename: 'Übung 1.png',
      sizeBytes: 4096,
    });
    if (!result.ok) return;

    expect(lookupContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, 'pages/lab-1/assets/Übung 1.png');
    const url = new URL(result.url);
    expect(url.pathname).toBe(`/c/${CLASSROOM_ID}/blob/${BLOB_SHA}.png`);
    expect(url.searchParams.get('p')).toBe('download');
    expect(result.expiresAt).toBe(Number(url.searchParams.get('exp')));
    // Ten minutes, give or take the clock.
    const ttl = result.expiresAt - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(9 * 60);
    expect(ttl).toBeLessThanOrEqual(10 * 60 + 1);

    const verified = await verifyContentUrl(MASTER, result.url);
    expect(verified).toMatchObject({
      ok: true,
      kind: 'blob',
      tier: 'download',
      sha: BLOB_SHA,
      downloadFilename: 'Übung 1.png',
    });
  });

  it('reports an unknown size as null', async () => {
    lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'blob', size: 0 });
    const result = await resolveRepoFileDownloadUrl(classroom, {
      folder: FOLDER,
      path: `${FOLDER}/a.png`,
    });
    expect(result).toMatchObject({ ok: true, sizeBytes: null });
  });

  it('refuses a path outside the folder before looking anything up', async () => {
    for (const path of [
      'pages/lab-1/content.json',
      'pages/lab-1/assets/../content.json',
      'pages/lab-2/assets/a.png',
      '/pages/lab-1/assets/a.png',
      'pages\\lab-1\\assets\\a.png',
      'https://github.com/org/repo/pages/lab-1/assets/a.png',
      FOLDER,
    ]) {
      expect(await resolveRepoFileDownloadUrl(classroom, { folder: FOLDER, path }), path).toEqual({
        ok: false,
        reason: 'bad_path',
      });
    }
    expect(lookupContentAsset).not.toHaveBeenCalled();
  });

  it('says `delivery_off` when the classroom is not on the layer', async () => {
    expect(
      await resolveRepoFileDownloadUrl(
        { ...classroom, content_delivery_enabled: false },
        { folder: FOLDER, path: `${FOLDER}/a.png` }
      )
    ).toEqual({ ok: false, reason: 'delivery_off' });
  });

  it('refuses a path with no blob row, and a folder', async () => {
    lookupContentAsset.mockResolvedValue(null);
    expect(
      await resolveRepoFileDownloadUrl(classroom, { folder: FOLDER, path: `${FOLDER}/a.png` })
    ).toEqual({ ok: false, reason: 'not_in_map' });
    lookupContentAsset.mockResolvedValue({ sha: BLOB_SHA, type: 'tree', size: 0 });
    expect(
      await resolveRepoFileDownloadUrl(classroom, { folder: FOLDER, path: `${FOLDER}/sub` })
    ).toEqual({ ok: false, reason: 'not_in_map' });
  });
});

describe('repoPathInFolder', () => {
  it('collapses cosmetic segments and nothing else', () => {
    expect(repoPathInFolder(FOLDER, 'pages/lab-1/./assets//a.png')).toBe(`${FOLDER}/a.png`);
    expect(repoPathInFolder(FOLDER, 'pages/lab-1/assets-old/a.png')).toBeNull();
    expect(repoPathInFolder(FOLDER, `${FOLDER}/a.png?x=1`)).toBeNull();
    expect(repoPathInFolder('', `${FOLDER}/a.png`)).toBeNull();
  });
});
