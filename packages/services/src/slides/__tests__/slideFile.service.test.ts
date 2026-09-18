/**
 * FILE and LINK slides: the write paths, and what a viewer gets back.
 *
 * The three things worth a test here are all orderings rather than outputs:
 *
 *   - a create refuses a slug collision BEFORE it writes to GitHub, because the
 *     content path is derived from the slug and an unchecked create would
 *     overwrite another slide's folder;
 *   - a REPLACE commits the new document, repoints the row, and only then
 *     removes the old one — and never removes a path it just wrote;
 *   - a download redirects when the classroom is on the delivery layer and
 *     streams the same bytes under the same filename when it is not.
 *
 * GitHub, the asset map and the manifest are mocked; the signer is not, because
 * the redirect branch is only correct if the URL it hands back is real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── The database ────────────────────────────────────────────────────────────

const classroomFindUnique = vi.fn();
const slideFindFirst = vi.fn();
const slideFindUnique = vi.fn();
const slideCreate = vi.fn();
const slideUpdate = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUnique(...args) },
    slide: {
      findFirst: (...args: unknown[]) => slideFindFirst(...args),
      findUnique: (...args: unknown[]) => slideFindUnique(...args),
      create: (...args: unknown[]) => slideCreate(...args),
      update: (...args: unknown[]) => slideUpdate(...args),
    },
  }),
}));

// ─── GitHub ──────────────────────────────────────────────────────────────────

/** Everything that touched the repo or the map, in the order it happened. */
const events: string[] = [];

const uploadBatch = vi.fn(async ({ files }: { files: Array<{ path: string }> }) => {
  events.push(`commit:${files.map(file => file.path).join(',')}`);
  return {
    commit: 'commit-sha',
    filesUploaded: files.length,
    files: files.map(file => ({ path: file.path, sha: 'b'.repeat(40) })),
  };
});
const deleteFile = vi.fn(async ({ path }: { path: string }) => {
  events.push(`delete:${path}`);
  return { commit: 'delete-commit' };
});
const getLargeContent = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    uploadBatch: (...args: unknown[]) =>
      uploadBatch(...(args as [{ files: Array<{ path: string }> }])),
    delete: (...args: unknown[]) => deleteFile(...(args as [{ path: string }])),
    getLargeContent: (...a: unknown[]) => getLargeContent(...a),
    getContent: vi.fn(),
    getMeta: vi.fn(),
    deleteFolder: vi.fn(),
    deleteBranch: vi.fn(),
  },
}));

// ─── The asset map ───────────────────────────────────────────────────────────

const ensureContentAssetsOutcome = vi.fn(async () => ({ mapIsTrustworthy: true }));
const lookupContentAsset = vi.fn();
const recordContentAssets = vi.fn(async (_id: string, entries: Array<{ path: string }>) => {
  events.push(`record:${entries.map(entry => entry.path).join(',')}`);
  return true;
});
const removeContentAssets = vi.fn(async (_id: string, paths: string[]) => {
  events.push(`forget:${paths.join(',')}`);
  return true;
});

vi.mock('../../classmoji/contentAssets.service.ts', async importActual => ({
  ...(await importActual<typeof import('../../classmoji/contentAssets.service.ts')>()),
  ensureContentAssetsOutcome: () => ensureContentAssetsOutcome(),
  lookupContentAsset: (...args: unknown[]) => lookupContentAsset(...args),
  recordContentAssets: (...args: unknown[]) =>
    recordContentAssets(...(args as [string, Array<{ path: string }>])),
  removeContentAssets: (...args: unknown[]) => removeContentAssets(...(args as [string, string[]])),
  removeContentAssetFolder: vi.fn(),
}));

const saveManifest = vi.fn(async () => {
  events.push('manifest');
  return true;
});
vi.mock('../../classmoji/contentManifest.service.ts', () => ({
  saveManifest: () => saveManifest(),
}));

const ensureContentRepo = vi.fn(async () => {
  events.push('ensure-repo');
  return { repoName: 'content-test-org-cs101' };
});
vi.mock('../../classmoji/page.service.ts', () => ({
  ensureContentRepo: () => ensureContentRepo(),
}));

// Trigger.dev is never reached from these paths; stubbing the client keeps the
// suite from opening a queue connection because `slide.service` imports it.
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn(), batchTrigger: vi.fn() } }));

const {
  createFileSlide,
  createLinkSlide,
  openSlideFile,
  readSlideFileBytes,
  replaceSlideFile,
  slideDownloadUrl,
  SlideSourceError,
} = await import('../slideFile.service.ts');
const { SlideKindError } = await import('../slideSource.ts');

const CLASSROOM_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const gitOrganization = {
  provider: 'GITHUB',
  login: 'test-org',
  github_installation_id: '123',
};
const classroom = {
  id: CLASSROOM_ID,
  content_repo: 'content-test-org-cs101',
  content_key_version: 3,
  content_delivery_enabled: true,
  git_organization: gitOrganization,
};

const PDF = Buffer.from('%PDF-1.7 pretend');

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  process.env.CONTENT_DELIVERY_ORIGIN = 'https://cdn.classmoji.test';
  process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
  classroomFindUnique.mockResolvedValue(classroom);
  slideFindFirst.mockResolvedValue(null);
  slideCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'slide-1',
    ...data,
  }));
  slideUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'slide-1',
    ...data,
  }));
  ensureContentAssetsOutcome.mockResolvedValue({ mapIsTrustworthy: true });
  lookupContentAsset.mockResolvedValue({ sha: 'b'.repeat(40), type: 'blob', size: PDF.length });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
  vi.restoreAllMocks();
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe('createFileSlide', () => {
  it('commits one file, records it, and stores both names', async () => {
    const { slide, path } = await createFileSlide({
      classroomId: CLASSROOM_ID,
      title: 'Lecture 1',
      createdBy: 'user-1',
      filename: 'Lecture 1 — Intro.pdf',
      file: PDF,
    });

    expect(path).toBe('slides/lecture-1/lecture-1-intro.pdf');
    expect(slide).toMatchObject({
      kind: 'FILE',
      content_path: 'slides/lecture-1',
      source_path: 'slides/lecture-1/lecture-1-intro.pdf',
      // The STORAGE name is ASCII; the DISPLAY name is what was uploaded.
      source_filename: 'Lecture 1 — Intro.pdf',
      source_mime: 'application/pdf',
      source_size: PDF.length,
    });

    // The map row lands before anything can ask for a download URL, which is
    // signed FROM the map.
    expect(events).toEqual([
      'ensure-repo',
      'commit:slides/lecture-1/lecture-1-intro.pdf',
      'record:slides/lecture-1/lecture-1-intro.pdf',
      'manifest',
    ]);
  });

  it('refuses a file the policy will not take, before touching GitHub', async () => {
    await expect(
      createFileSlide({
        classroomId: CLASSROOM_ID,
        title: 'Notes',
        createdBy: 'user-1',
        filename: 'notes.txt',
        file: PDF,
      })
    ).rejects.toBeInstanceOf(SlideSourceError);
    expect(uploadBatch).not.toHaveBeenCalled();
    expect(ensureContentRepo).not.toHaveBeenCalled();
  });

  it('refuses a slug collision before touching GitHub', async () => {
    // The content path is derived from the slug, so an unchecked create would
    // write INTO the existing slide's folder.
    slideFindFirst.mockResolvedValue({ id: 'other', title: 'Lecture 1' });
    await expect(
      createFileSlide({
        classroomId: CLASSROOM_ID,
        title: 'Lecture 1',
        createdBy: 'user-1',
        filename: 'a.pdf',
        file: PDF,
      })
    ).rejects.toMatchObject({ code: 'SLIDE_CONTENT_PATH_CONFLICT' });
    expect(uploadBatch).not.toHaveBeenCalled();
  });
});

describe('createLinkSlide', () => {
  it('stores a normalized URL and writes nothing to the repo', async () => {
    const { slide, host } = await createLinkSlide({
      classroomId: CLASSROOM_ID,
      title: 'Reading list',
      createdBy: 'user-1',
      url: 'https://Example.com/reading  ',
    });

    expect(slide).toMatchObject({
      kind: 'LINK',
      content_path: 'slides/reading-list',
      source_url: 'https://example.com/reading',
    });
    expect(host).toBe('example.com');
    // No commit, no repo provisioning — a link is a row.
    expect(events).toEqual(['manifest']);
    expect(ensureContentRepo).not.toHaveBeenCalled();
  });

  it('refuses a link that is not plain https', async () => {
    await expect(
      createLinkSlide({
        classroomId: CLASSROOM_ID,
        title: 'Bad',
        createdBy: 'user-1',
        url: 'javascript:alert(1)',
      })
    ).rejects.toBeInstanceOf(SlideSourceError);
    expect(slideCreate).not.toHaveBeenCalled();
  });
});

// ─── Replace ─────────────────────────────────────────────────────────────────

describe('replaceSlideFile', () => {
  const existing = {
    id: 'slide-1',
    title: 'Lecture 1',
    slug: 'lecture-1',
    content_path: 'slides/lecture-1',
    classroom_id: CLASSROOM_ID,
    kind: 'FILE',
    source_path: 'slides/lecture-1/old.pdf',
    classroom,
  };

  it('commits, repoints the row, and only then removes the old document', async () => {
    slideFindUnique.mockResolvedValue(existing);

    const { path } = await replaceSlideFile({
      slideId: 'slide-1',
      filename: 'Week 2.pdf',
      file: PDF,
    });

    expect(path).toBe('slides/lecture-1/week-2.pdf');
    expect(events).toEqual([
      'commit:slides/lecture-1/week-2.pdf',
      'record:slides/lecture-1/week-2.pdf',
      'delete:slides/lecture-1/old.pdf',
      'forget:slides/lecture-1/old.pdf',
    ]);
    // The row moved before the old file was removed, so a failure in between
    // leaves the slide serving the NEW document rather than nothing.
    expect(slideUpdate).toHaveBeenCalledBefore(deleteFile);
  });

  it('never deletes the file it just wrote', async () => {
    // Re-uploading under the same name writes the same path. Removing "the old
    // one" here would delete the replacement.
    slideFindUnique.mockResolvedValue({
      ...existing,
      source_path: 'slides/lecture-1/week-2.pdf',
    });

    await replaceSlideFile({ slideId: 'slide-1', filename: 'Week 2.pdf', file: PDF });

    expect(deleteFile).not.toHaveBeenCalled();
    expect(removeContentAssets).not.toHaveBeenCalled();
  });

  it('survives a failed cleanup — the replacement is already live', async () => {
    slideFindUnique.mockResolvedValue(existing);
    deleteFile.mockRejectedValueOnce(new Error('GitHub is having a day'));

    await expect(
      replaceSlideFile({ slideId: 'slide-1', filename: 'Week 2.pdf', file: PDF })
    ).resolves.toMatchObject({ path: 'slides/lecture-1/week-2.pdf' });
  });

  it('refuses a slide that is not a file', async () => {
    slideFindUnique.mockResolvedValue({ ...existing, kind: 'DECK' });
    await expect(
      replaceSlideFile({ slideId: 'slide-1', filename: 'a.pdf', file: PDF })
    ).rejects.toBeInstanceOf(SlideKindError);
    expect(uploadBatch).not.toHaveBeenCalled();
  });
});

// ─── Read ────────────────────────────────────────────────────────────────────

describe('opening a file slide', () => {
  const slide = {
    id: 'slide-1',
    title: 'Lecture 1',
    content_path: 'slides/lecture-1',
    kind: 'FILE',
    source_path: 'slides/lecture-1/lecture-1.pdf',
    source_filename: 'Lecture 1 — Intro.pdf',
    source_mime: 'application/pdf',
    classroom,
  };

  it('redirects to a signed download when the classroom is on the layer', async () => {
    const result = await openSlideFile(slide);
    expect(result.mode).toBe('redirect');
    if (result.mode !== 'redirect') return;
    expect(new URL(result.url).searchParams.get('p')).toBe('download');
    expect(result.filename).toBe('Lecture 1 — Intro.pdf');
    // Nothing was read into this process.
    expect(getLargeContent).not.toHaveBeenCalled();
  });

  it('streams the bytes itself when the classroom is not', async () => {
    getLargeContent.mockResolvedValue({
      content: PDF.toString('base64'),
      sha: 'b'.repeat(40),
    });

    const result = await openSlideFile({
      ...slide,
      classroom: { ...classroom, content_delivery_enabled: false },
    });

    expect(result.mode).toBe('stream');
    if (result.mode !== 'stream') return;
    expect(result.body.equals(PDF)).toBe(true);
    expect(result.contentType).toBe('application/pdf');
    // The same header the Worker would have sent: an ASCII fallback plus the
    // RFC 8187 form carrying the em dash.
    expect(result.disposition).toContain('attachment;');
    expect(result.disposition).toContain("filename*=UTF-8''");
  });

  it('says so, rather than streaming, when the file is missing from the map', async () => {
    lookupContentAsset.mockResolvedValue(null);
    expect(await openSlideFile(slide)).toEqual({ mode: 'unavailable', reason: 'not_in_map' });
    // A missing row is a real fault; reading 75 MB from GitHub would hide it.
    expect(getLargeContent).not.toHaveBeenCalled();
  });

  it('refuses a slide that is not a file at all', async () => {
    expect(await openSlideFile({ ...slide, kind: 'LINK' })).toEqual({
      mode: 'unavailable',
      reason: 'not_a_file',
    });
  });

  it('falls back to the storage name when the stored one is unusable', async () => {
    getLargeContent.mockResolvedValue({ content: PDF.toString('base64'), sha: 'b'.repeat(40) });
    const bytes = await readSlideFileBytes({
      ...slide,
      source_filename: 'we‮ird.pdf',
      classroom: { ...classroom, content_delivery_enabled: false },
    });
    expect(bytes?.filename).toBe('lecture-1.pdf');
  });

  it('declines to sign for a classroom with no repo configured', async () => {
    expect(
      await slideDownloadUrl({ ...slide, classroom: { ...classroom, content_repo: null } })
    ).toEqual({ ok: false, reason: 'delivery_off' });
  });
});
