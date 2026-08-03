/**
 * saveDeck §3 2×2 conflict table + preview source-only rule + loadDeck
 * deck.json-first fallback. ContentService and prisma are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeckJson } from '../deckTypes.ts';

const slideUpdateMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: { update: (...args: unknown[]) => slideUpdateMock(...args) },
  }),
}));

const getMetaMock = vi.fn();
const getContentMock = vi.fn();
const uploadBatchMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    getMeta: (...args: unknown[]) => getMetaMock(...args),
    getContent: (...args: unknown[]) => getContentMock(...args),
    uploadBatch: (...args: unknown[]) => uploadBatchMock(...args),
  },
}));

const { loadDeck, saveDeck, DeckConflictError, previewBranchName, PREVIEW_BRANCH_PREFIX } =
  await import('../slideContent.service.ts');
const { DeckParseError } = await import('../deckHtml.ts');

const gitOrganization = { provider: 'GITHUB', login: 'test-org' };
const slide = {
  id: 'slide-1',
  title: 'My Deck',
  content_path: 'slides/my-deck',
  classroom: { content_namespace: '26w', git_organization: gitOrganization },
};

const deck: DeckJson = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  slides: [{ id: 'aaaa1111', html: '<h1>Hi</h1>' }],
};

const DECK_PATH = 'slides/my-deck/deck.json';
const HTML_PATH = 'slides/my-deck/index.html';

beforeEach(() => {
  vi.clearAllMocks();
  // Echo the input file paths back (the real uploadBatch returns per-file
  // blob shas for whatever it was given).
  uploadBatchMock.mockImplementation(({ files }: { files: Array<{ path: string }> }) =>
    Promise.resolve({
      commit: 'commit-1',
      filesUploaded: files.length,
      files: files.map(f => ({
        path: f.path,
        sha: f.path.endsWith('deck.json') ? 'new-deck-sha' : 'new-html-sha',
      })),
    })
  );
  slideUpdateMock.mockResolvedValue({});
});

describe('previewBranchName', () => {
  it('builds the singleton preview branch name from the content path', () => {
    expect(previewBranchName('slides/my-deck')).toBe('preview/slides/my-deck');
    expect(PREVIEW_BRANCH_PREFIX).toBe('preview/');
  });
});

describe('saveDeck — §3 conflict table', () => {
  it("row 1: shaSource 'deck', sha matches → proceeds with the dual-write", async () => {
    getMetaMock.mockResolvedValue({ sha: 'expected-sha', size: 10 });

    const result = await saveDeck({
      slide,
      deck,
      expectedSha: 'expected-sha',
      shaSource: 'deck',
      message: 'update deck',
    });

    // Conflict check: deck.json meta, skipCache REQUIRED, default branch
    expect(getMetaMock).toHaveBeenCalledTimes(1);
    expect(getMetaMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: DECK_PATH, skipCache: true, ref: undefined })
    );

    // ONE batch commit: deck.json + index.html to main
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    const call = uploadBatchMock.mock.calls[0][0];
    expect(call.repo).toBe('content-test-org-26w');
    expect(call.branch).toBe('main');
    expect(call.files.map((f: { path: string }) => f.path)).toEqual([DECK_PATH, HTML_PATH]);
    expect(call.files[0].content).toBe(JSON.stringify(deck, null, 2) + '\n');
    expect(call.files[1].content).toContain('<h1>Hi</h1>');

    // Returns deck.json's new sha + commit + generated html
    expect(result.sha).toBe('new-deck-sha');
    expect(result.commit).toBe('commit-1');
    expect(result.html).toContain('data-cm-id="aaaa1111"');

    // updated_at bumped for main writes
    expect(slideUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'slide-1' } })
    );
  });

  it("row 2: shaSource 'deck', sha differs → 409, no write", async () => {
    getMetaMock.mockResolvedValue({ sha: 'someone-elses-sha', size: 10 });

    await expect(
      saveDeck({ slide, deck, expectedSha: 'expected-sha', shaSource: 'deck', message: 'm' })
    ).rejects.toThrow(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
    expect(slideUpdateMock).not.toHaveBeenCalled();
  });

  it("row 3: shaSource 'deck', deck.json missing (deleted out-of-band) → 409", async () => {
    getMetaMock.mockResolvedValue(null);

    await expect(
      saveDeck({ slide, deck, expectedSha: 'expected-sha', shaSource: 'deck', message: 'm' })
    ).rejects.toThrow(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it("row 4: shaSource 'legacy_html', deck.json now exists (materialized) → 409", async () => {
    getMetaMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(path === DECK_PATH ? { sha: 'materialized', size: 5 } : null)
    );

    await expect(
      saveDeck({ slide, deck, expectedSha: 'html-sha', shaSource: 'legacy_html', message: 'm' })
    ).rejects.toThrow(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it("row 5: shaSource 'legacy_html', deck.json absent, html sha matches → proceeds", async () => {
    getMetaMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(path === HTML_PATH ? { sha: 'html-sha', size: 5 } : null)
    );

    const result = await saveDeck({
      slide,
      deck,
      expectedSha: 'html-sha',
      shaSource: 'legacy_html',
      message: 'm',
    });
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
    expect(result.sha).toBe('new-deck-sha');
    // Both checks ran with skipCache
    for (const call of getMetaMock.mock.calls) {
      expect(call[0].skipCache).toBe(true);
    }
  });

  it("row 6: shaSource 'legacy_html', html sha differs or missing → 409", async () => {
    getMetaMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(path === HTML_PATH ? { sha: 'changed-sha', size: 5 } : null)
    );
    await expect(
      saveDeck({ slide, deck, expectedSha: 'html-sha', shaSource: 'legacy_html', message: 'm' })
    ).rejects.toThrow(DeckConflictError);

    getMetaMock.mockResolvedValue(null); // html missing too
    await expect(
      saveDeck({ slide, deck, expectedSha: 'html-sha', shaSource: 'legacy_html', message: 'm' })
    ).rejects.toThrow(DeckConflictError);
    expect(uploadBatchMock).not.toHaveBeenCalled();
  });

  it('conflict errors carry status 409 and CONTENT_CONFLICT code', async () => {
    getMetaMock.mockResolvedValue(null);
    try {
      await saveDeck({ slide, deck, expectedSha: 'x', shaSource: 'deck', message: 'm' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InstanceType<typeof DeckConflictError>).status).toBe(409);
      expect((error as InstanceType<typeof DeckConflictError>).code).toBe('CONTENT_CONFLICT');
    }
  });

  it('no expectedSha (first write) → no conflict check, straight to the batch', async () => {
    await saveDeck({ slide, deck, message: 'create' });
    expect(getMetaMock).not.toHaveBeenCalled();
    expect(uploadBatchMock).toHaveBeenCalledTimes(1);
  });
});

describe('saveDeck — preview branches (§3b source-only)', () => {
  it('writes deck.json ONLY to a preview branch and checks the sha on that branch', async () => {
    const branch = previewBranchName('slides/my-deck');
    getMetaMock.mockResolvedValue({ sha: 'expected-sha', size: 10 });
    uploadBatchMock.mockResolvedValue({
      commit: 'preview-commit',
      filesUploaded: 1,
      files: [{ path: DECK_PATH, sha: 'preview-deck-sha' }],
    });

    const result = await saveDeck({
      slide,
      deck,
      expectedSha: 'expected-sha',
      shaSource: 'deck',
      message: 'preview edit',
      branch,
    });

    // Conflict check reads the branch being written
    expect(getMetaMock).toHaveBeenCalledWith(expect.objectContaining({ ref: branch }));

    // Source-only: index.html is never committed to a preview branch
    const call = uploadBatchMock.mock.calls[0][0];
    expect(call.branch).toBe(branch);
    expect(call.files.map((f: { path: string }) => f.path)).toEqual([DECK_PATH]);

    // updated_at NOT bumped (nothing visible on main changed)
    expect(slideUpdateMock).not.toHaveBeenCalled();

    expect(result.sha).toBe('preview-deck-sha');
    expect(result.commit).toBe('preview-commit');
    // html still returned (preview viewer renders server-side from the deck)
    expect(result.html).toContain('<h1>Hi</h1>');
  });

  it('a non-preview branch still gets the dual-write', async () => {
    await saveDeck({ slide, deck, message: 'm', branch: 'some-other-branch' });
    const call = uploadBatchMock.mock.calls[0][0];
    expect(call.branch).toBe('some-other-branch');
    expect(call.files.map((f: { path: string }) => f.path)).toEqual([DECK_PATH, HTML_PATH]);
  });
});

describe('saveDeck — misc', () => {
  it('skips the updated_at bump when the slide row does not exist yet (createSlide)', async () => {
    await saveDeck({
      slide: { title: 'New', content_path: 'slides/new', classroom: slide.classroom },
      deck,
      message: 'create',
    });
    expect(slideUpdateMock).not.toHaveBeenCalled();
  });

  it('throws when the git organization is not configured', async () => {
    await expect(
      saveDeck({
        slide: { title: 'X', content_path: 'slides/x', classroom: null },
        deck,
        message: 'm',
      })
    ).rejects.toThrow('Git organization not configured');
  });

  it('throws when the classroom content namespace is missing', async () => {
    await expect(
      saveDeck({
        slide: {
          title: 'X',
          content_path: 'slides/x',
          classroom: { content_namespace: null, git_organization: gitOrganization },
        },
        deck,
        message: 'm',
      })
    ).rejects.toThrow('content namespace');
  });
});

describe('loadDeck', () => {
  const LEGACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Legacy</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/sky.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
</head>
<body>
  <div class="reveal" data-theme="sky" data-code-theme="github">
    <div class="slides">
<section><h1>Legacy</h1></section>
    </div>
  </div>
</body>
</html>`;

  it('reads deck.json first and returns sha_source deck', async () => {
    getContentMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(
        path === DECK_PATH ? { content: JSON.stringify(deck), sha: 'deck-sha' } : null
      )
    );

    const result = await loadDeck(slide, { skipCache: true });
    expect(result.deck).toEqual(deck);
    expect(result.sha).toBe('deck-sha');
    expect(result.sha_source).toBe('deck');
    expect(getContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: DECK_PATH, skipCache: true })
    );
    // Never touched index.html
    expect(getContentMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to parsing index.html when deck.json is absent', async () => {
    getContentMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(path === HTML_PATH ? { content: LEGACY_HTML, sha: 'html-sha' } : null)
    );

    const result = await loadDeck(slide);
    expect(result.sha_source).toBe('legacy_html');
    expect(result.sha).toBe('html-sha');
    expect(result.deck.theme).toBe('sky');
    expect(result.deck.slides).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('passes ref through to both reads (preview inspection)', async () => {
    getContentMock.mockResolvedValue(null);
    await expect(loadDeck(slide, { ref: 'preview/slides/my-deck' })).rejects.toThrow(
      'Slide content not found'
    );
    for (const call of getContentMock.mock.calls) {
      expect(call[0].ref).toBe('preview/slides/my-deck');
    }
  });

  it('throws DeckParseError on malformed deck.json (never silently falls back)', async () => {
    getContentMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(path === DECK_PATH ? { content: '{not json', sha: 'x' } : null)
    );
    await expect(loadDeck(slide)).rejects.toThrow(DeckParseError);

    getContentMock.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve(
        path === DECK_PATH ? { content: JSON.stringify({ version: 2 }), sha: 'x' } : null
      )
    );
    await expect(loadDeck(slide)).rejects.toThrow(DeckParseError);
  });

  it('throws when neither deck.json nor index.html exists', async () => {
    getContentMock.mockResolvedValue(null);
    await expect(loadDeck(slide)).rejects.toThrow('Slide content not found');
  });
});
