/**
 * The term-rollover copy, once the tree can reference media objects.
 *
 * The push carries the tree, and a `media://{id}` in it names an object the
 * SOURCE classroom owns — the target will not find it. So before the push, the
 * helper hands every text file that could hold a media reference to the run's
 * media copy, which copies the objects into the target; then the rewrite pass
 * repoints the references through the same copy. What is pinned here is that
 * ordering and that wiring — the copy itself is the services' to test.
 *
 * Real filesystem (the helper's own working directory, removed in its
 * `finally`); `simple-git`, `@trigger.dev/sdk` and `@classmoji/services` are
 * mocked. The file contents are captured at `git add` time, which is what the
 * push would carry.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  pushedTree: new Map<string, string>(),
  seed: new Map<string, string>(),
  failPush: false,
}));

function readTree(dir: string, root = dir, out = new Map<string, string>()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readTree(full, root, out);
    else
      out.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
  }
  return out;
}

vi.mock('simple-git', () => ({
  simpleGit: (dir?: string) => ({
    clone: async (_url: string, localPath: string) => {
      for (const [file, text] of mocks.seed) {
        const full = path.join(localPath, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text, 'utf8');
      }
    },
    raw: async () => 'abc123',
    init: async () => {},
    addConfig: async () => {},
    checkoutLocalBranch: async () => {},
    add: async () => {
      mocks.order.push('add');
      mocks.pushedTree = readTree(dir as string);
    },
    commit: async () => {},
    addRemote: async () => {},
    push: async () => {
      mocks.order.push('push');
      if (mocks.failPush) throw new Error('remote hung up');
    },
  }),
}));

vi.mock('@trigger.dev/sdk', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    contentImport: {
      // The real rewriter runs `rewriteMedia` first; that is all this needs.
      rewriteContentUrls: (text: string, ctx: { rewriteMedia?: (t: string) => string }) =>
        ctx.rewriteMedia ? ctx.rewriteMedia(text) : text,
      isTextContentPath: (p: string) => /\.(json|html?|md|css|js|txt|svg)$/i.test(p),
      mayReferenceMedia: (t: string) => t.includes('media://') || t.includes('/media/'),
    },
  },
  redactAccessTokens: (text: string) => text,
}));

const { cloneContentRepo, oversizedWarning } = await import('../cloneContentRepo.ts');

const SOURCE = { orgLogin: 'uniglos', repo: 'content-25', token: 'ghs_src' };
const TARGET = { orgLogin: 'uniglos', repo: 'content-26', token: 'ghs_tgt' };
const OLD = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const NEW = '44444444-4444-4444-8444-444444444444';
const UNCOPIED = '33333333-3333-4333-8333-333333333333';

function fakeMedia() {
  const prepared: string[][] = [];
  const copied = new Map<string, string>();
  return {
    prepared,
    discard: vi.fn(async () => {
      mocks.order.push('discard');
    }),
    keep: vi.fn(() => {
      mocks.order.push('keep');
    }),
    prepare: vi.fn(async (texts: readonly (string | null | undefined)[]) => {
      mocks.order.push('prepare');
      prepared.push(texts.filter((t): t is string => typeof t === 'string'));
      copied.set(OLD, NEW);
    }),
    rewrite: (text: string) =>
      text.replace(/media:\/\/([0-9a-f-]{36})/g, (ref, id: string) =>
        copied.has(id) ? `media://${copied.get(id)}` : ref
      ),
  };
}

const run = (media?: ReturnType<typeof fakeMedia>, warn?: (detail: string) => void) =>
  cloneContentRepo({
    source: SOURCE,
    target: TARGET,
    keepPages: true,
    keepSlides: true,
    commitMessage: 'Import content from content-25',
    ...(media ? { media } : {}),
    ...(warn ? { warn } : {}),
  });

beforeEach(() => {
  mocks.failPush = false;
  mocks.order.length = 0;
  mocks.pushedTree = new Map();
  mocks.seed = new Map([
    ['pages/lab-1/content.json', `{"a":"media://${OLD}","b":"media://${UNCOPIED}"}`],
    ['slides/week-1/index.html', `<video src="media://${OLD}"></video>`],
    ['pages/lab-2/content.json', '{"plain":"pages/lab-2/a.png"}'],
    ['pages/lab-1/assets/clip.png', 'not text media://not-scanned'],
  ]);
});

describe('cloneContentRepo — media in the tree', () => {
  it('copies before the push, only the texts that could reference media', async () => {
    const media = fakeMedia();

    await expect(run(media)).resolves.toMatchObject({ pushed: true });

    expect(mocks.order).toEqual(['prepare', 'add', 'push', 'keep']);
    expect(media.prepare).toHaveBeenCalledTimes(1);
    // The two text files with a marker — not the plain page, not the binary.
    expect(media.prepared[0].sort()).toEqual(
      [
        `<video src="media://${OLD}"></video>`,
        `{"a":"media://${OLD}","b":"media://${UNCOPIED}"}`,
      ].sort()
    );
  });

  it('pushes the copied refs repointed and the uncopied ones as they were', async () => {
    await run(fakeMedia());

    expect(mocks.pushedTree.get('pages/lab-1/content.json')).toBe(
      `{"a":"media://${NEW}","b":"media://${UNCOPIED}"}`
    );
    expect(mocks.pushedTree.get('slides/week-1/index.html')).toBe(
      `<video src="media://${NEW}"></video>`
    );
    expect(mocks.pushedTree.get('pages/lab-2/content.json')).toBe('{"plain":"pages/lab-2/a.png"}');
  });

  it('without a media copy, pushes media refs verbatim', async () => {
    await run();

    expect(mocks.order).toEqual(['add', 'push']);
    expect(mocks.pushedTree.get('pages/lab-1/content.json')).toBe(
      `{"a":"media://${OLD}","b":"media://${UNCOPIED}"}`
    );
  });
});

describe('cloneContentRepo — a push that fails', () => {
  it('discards the media copies made for the tree, then rethrows', async () => {
    mocks.failPush = true;
    const media = fakeMedia();

    await expect(run(media)).rejects.toThrow(/pushing to uniglos\/content-26 failed/);

    expect(mocks.order).toEqual(['prepare', 'add', 'push', 'discard']);
    expect(media.discard).toHaveBeenCalledTimes(1);
    expect(media.keep).not.toHaveBeenCalled();
  });

  it('keeps the copies once the push has landed', async () => {
    const media = fakeMedia();
    await run(media);
    expect(media.discard).not.toHaveBeenCalled();
    // Marked kept right after the push, so a later step of the run that fails
    // and discards cannot remove what the pushed tree references.
    expect(mocks.order).toEqual(['prepare', 'add', 'push', 'keep']);
    expect(media.keep).toHaveBeenCalledTimes(1);
  });
});

describe('cloneContentRepo — text files too large to rewrite', () => {
  it('rewrites only their media refs, and names them in ONE import warning', async () => {
    const pad = 'x'.repeat(5 * 1024 * 1024);
    const repoLink = 'https://github.com/uniglos/content-25/blob/main/pages/a.png';
    const big = `{"v":"media://${OLD}","link":"${repoLink}","pad":"${pad}"}`;
    mocks.seed.set('pages/huge/content.json', big);
    mocks.seed.set('slides/huge/index.html', big);
    const rewriteContentUrls = vi.fn(
      (text: string, ctx: { rewriteMedia?: (t: string) => string }) =>
        ctx.rewriteMedia ? ctx.rewriteMedia(text) : text
    );
    const { ClassmojiService } = await import('@classmoji/services');
    const real = ClassmojiService.contentImport.rewriteContentUrls;
    ClassmojiService.contentImport.rewriteContentUrls = rewriteContentUrls as never;
    const media = fakeMedia();
    const warnings: string[] = [];

    try {
      await run(media, detail => warnings.push(detail));
    } finally {
      ClassmojiService.contentImport.rewriteContentUrls = real;
    }

    // Handed to the media copy in the same single call, and media-rewritten.
    expect(media.prepare).toHaveBeenCalledTimes(1);
    expect(media.prepared[0].filter(text => text.length > 5 * 1024 * 1024)).toHaveLength(2);
    const expected = `{"v":"media://${NEW}","link":"${repoLink}","pad":"${pad}"}`;
    expect(mocks.pushedTree.get('pages/huge/content.json')).toBe(expected);
    expect(mocks.pushedTree.get('slides/huge/index.html')).toBe(expected);
    // The repo-URL rewrite ran on the small files and never saw these.
    expect(rewriteContentUrls).toHaveBeenCalled();
    for (const [text] of rewriteContentUrls.mock.calls) {
      expect(text.length).toBeLessThan(5 * 1024 * 1024);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2 text files over 5 MB');
    expect(warnings[0]).toContain('pages/huge/content.json (5 MB)');
    expect(warnings[0]).toContain('slides/huge/index.html (5 MB)');
    expect(warnings[0]).toContain("links to the source class's repository");
    expect(warnings[0]).not.toContain('media');
  });

  it('without a media copy, pushes them verbatim', async () => {
    const big = `{"v":"media://${OLD}","pad":"${'x'.repeat(5 * 1024 * 1024)}"}`;
    mocks.seed.set('pages/huge/content.json', big);

    await run();

    expect(mocks.pushedTree.get('pages/huge/content.json')).toBe(big);
  });

  it('warns about nothing when every text file was rewritable', async () => {
    const warnings: string[] = [];
    await run(fakeMedia(), detail => warnings.push(detail));
    expect(warnings).toEqual([]);
  });

  it('names five files and counts the rest', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      file: `f${i}.json`,
      size: 6 * 1024 * 1024,
    }));
    const text = oversizedWarning(files);
    expect(text).toContain('7 text files');
    expect(text).toContain('f4.json (6 MB)');
    expect(text).not.toContain('f5.json');
    expect(text).toContain('and 2 more');
    expect(oversizedWarning([files[0]])).toMatch(
      /^Copied text file over 5 MB without updating its links/
    );
  });
});
