/**
 * A page's stored document is not served through `/content/...`.
 *
 * Pages are read through the pages app. The legacy proxy keeps serving a page
 * folder's assets (images, SVG, downloads) on its membership rule, and refuses
 * exactly `<content_path>/content.json` and `<content_path>/index.html` when a
 * page row owns that folder.
 *
 * Runs in the Playwright runner without a browser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { matchRoutes } from 'react-router';
import { ClassmojiService } from '@classmoji/services';
import {
  canonicalProxyPath,
  deckDocumentDecision,
  pageDocumentDecision,
  pageDocumentFolderOf,
  storedContentPathForms,
} from '../../app/utils/slideDocumentAccess.ts';

const normalize = ClassmojiService.contentDelivery.normalizeRepoRelative;

/** The splat React Router hands the content route for a request pathname. */
function splatFor(pathname: string): string | undefined {
  const matches = matchRoutes([{ path: 'content/:org/:repo/*' }], pathname);
  return matches?.[0]?.params['*'];
}

/**
 * The route's gate, then the rule: what the content proxy decides for a raw
 * splat, with a page and a deck owning their folders. `null` is the gate's
 * refusal, before any lookup.
 */
async function decide(raw: string) {
  const path = canonicalProxyPath(raw, normalize);
  if (!path) return null;
  const page = await pageDocumentDecision({
    path,
    findPages: async folder => (folder === 'pages/lab-1' ? [{ id: 'page-1' }] : []),
  });
  const deck = await deckDocumentDecision({
    path,
    findDecks: async folder => (folder === 'slides/week-1' ? [{ id: 'deck-1' }] : []),
    rightsFor: async () => {
      throw new Response(null, { status: 403 });
    },
  });
  return { path, page: page.outcome, deck: deck.outcome };
}

test.describe('which paths are page documents', () => {
  test('content.json and index.html under a folder are', () => {
    expect(pageDocumentFolderOf('pages/lab-1/content.json')).toBe('pages/lab-1');
    expect(pageDocumentFolderOf('pages/lab-1/index.html')).toBe('pages/lab-1');
    expect(pageDocumentFolderOf('pages/week/lab-1/content.json')).toBe('pages/week/lab-1');
  });

  test('assets and look-alikes are not', () => {
    for (const path of [
      'pages/lab-1/hero.png',
      'pages/lab-1/diagram.svg',
      'pages/lab-1/handout.pdf',
      'pages/lab-1/content.json.bak',
      'pages/lab-1/index.html.orig',
      'pages/lab-1/my-content.json/x.png',
      '/content.json',
      'content.json',
      '/index.html',
      '.slidesthemes/theme/lib/offline-v2.css',
    ]) {
      expect(pageDocumentFolderOf(path), path).toBeNull();
    }
  });
});

test.describe('the page document rule', () => {
  test('an asset passes without a lookup', async () => {
    for (const path of ['pages/lab-1/hero.png', 'pages/lab-1/diagram.svg']) {
      let looked = false;
      const decision = await pageDocumentDecision({
        path,
        findPages: async () => {
          looked = true;
          return [{ id: 'page-1' }];
        },
      });
      expect(decision).toEqual({ outcome: 'pass' });
      expect(looked).toBe(false);
    }
  });

  test("a page's content.json and index.html are refused, asked by folder", async () => {
    for (const path of ['pages/lab-1/content.json', 'pages/lab-1/index.html']) {
      const asked: string[] = [];
      const decision = await pageDocumentDecision({
        path,
        findPages: async folder => {
          asked.push(folder);
          return [{ id: 'page-1' }];
        },
      });
      expect(decision).toEqual({ outcome: 'refuse' });
      expect(asked).toEqual(['pages/lab-1']);
    }
  });

  test('a document no page row claims passes to the rules after it', async () => {
    const decision = await pageDocumentDecision({
      path: 'slides/week-1/index.html',
      findPages: async () => [],
    });
    expect(decision).toEqual({ outcome: 'pass' });
  });
});

test.describe('only the repo-root spelling of a path is answered', () => {
  test('canonical paths come back unchanged', () => {
    for (const path of [
      'pages/lab-1/content.json',
      'pages/lab-1/assets/hero.png',
      'slides/week-1/index.html',
      '.slidesthemes/theme/lib/offline-v2.css',
      'slides/week-1/images/a b.png',
    ]) {
      expect(canonicalProxyPath(path, normalize), path).toBe(path);
    }
  });

  test('other spellings, `..` and unserved characters are refused', () => {
    for (const path of [
      'pages/lab-1//content.json',
      'pages/lab-1/./content.json',
      'pages/lab-1/content.json/',
      '/pages/lab-1/content.json',
      './pages/lab-1/content.json',
      'pages//lab-1/content.json',
      'pages/lab-1/../lab-1/content.json',
      '../pages/lab-1/content.json',
      'pages/lab-1/..',
      'slides/week-1//deck.json',
      'slides/week-1/./index.html',
      'slides/week-1/index.html/',
      'pages/lab-1\\content.json',
      'pages/lab-1/%2e/content.json',
      'pages/lab-1%2Fcontent.json',
      'pages/lab-1/content.json?x',
      'pages/lab-1/content.json#x',
      'pages/lab-1/content.js\non',
      'pages/lab-1/content.js\ton',
      '/',
      '.',
      '',
    ]) {
      expect(canonicalProxyPath(path, normalize), JSON.stringify(path)).toBeNull();
    }
  });

  test("React Router's decoding cannot produce a spelling the gate lets through", () => {
    const cases: Array<[string, string]> = [
      ['/content/o/r/pages/lab-1%2F%2Fcontent.json', 'pages/lab-1//content.json'],
      ['/content/o/r/pages/lab-1/%2e/content.json', 'pages/lab-1/./content.json'],
      ['/content/o/r/pages/lab-1/%2e%2e/lab-1/content.json', 'pages/lab-1/../lab-1/content.json'],
      ['/content/o/r/pages/lab-1%5Ccontent.json', 'pages/lab-1\\content.json'],
      ['/content/o/r/pages/lab-1/content.json%3Fx', 'pages/lab-1/content.json?x'],
      ['/content/o/r/pages/lab-1/content.json%23x', 'pages/lab-1/content.json#x'],
      ['/content/o/r/pages/lab-1/content.json%2F', 'pages/lab-1/content.json/'],
      // Double-encoded: React Router decodes once, then turns `%2F` into `/`.
      ['/content/o/r/pages/lab-1%252F%252Fcontent.json', 'pages/lab-1//content.json'],
      // Triple-encoded: a literal `%` survives, and is refused on its own.
      ['/content/o/r/pages/lab-1/%25252e/content.json', 'pages/lab-1/%252e/content.json'],
      ['/content/o/r//pages/lab-1/content.json', '/pages/lab-1/content.json'],
      ['/content/o/r/pages/lab-1//content.json', 'pages/lab-1//content.json'],
      ['/content/o/r/pages/lab-1/content.json/', 'pages/lab-1/content.json/'],
    ];
    for (const [pathname, splat] of cases) {
      expect(splatFor(pathname), pathname).toBe(splat);
      expect(canonicalProxyPath(splat, normalize), pathname).toBeNull();
    }
    // The ordinary request is untouched.
    expect(splatFor('/content/o/r/pages/lab-1/content.json')).toBe('pages/lab-1/content.json');
  });

  test('no spelling of a page document reaches the read', async () => {
    expect(await decide('pages/lab-1/content.json')).toEqual({
      path: 'pages/lab-1/content.json',
      page: 'refuse',
      deck: 'pass',
    });
    for (const raw of [
      'pages/lab-1//content.json',
      'pages/lab-1/./content.json',
      'pages/lab-1/content.json/',
      'pages/lab-1/./index.html',
      'pages/lab-1%2Fcontent.json',
      'pages/x/../lab-1/content.json',
    ]) {
      expect(await decide(raw), raw).toBeNull();
    }
  });

  test('no spelling of a deck document reaches the read', async () => {
    expect(await decide('slides/week-1/deck.json')).toEqual({
      path: 'slides/week-1/deck.json',
      page: 'pass',
      deck: 'refuse',
    });
    for (const raw of [
      'slides/week-1//deck.json',
      'slides/week-1/./index.html',
      'slides/week-1/index.html/',
      'slides//week-1/deck.json',
      'slides/week-1%2Fdeck.json',
      'slides/x/../week-1/deck.json',
    ]) {
      expect(await decide(raw), raw).toBeNull();
    }
  });
});

test.describe('stored content paths', () => {
  test('a folder is looked up with and without a leading or trailing slash', () => {
    expect(storedContentPathForms('pages/lab-1')).toEqual([
      'pages/lab-1',
      'pages/lab-1/',
      '/pages/lab-1',
      '/pages/lab-1/',
    ]);
  });
});

test.describe('the content proxy applies it', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../app/routes/content.$org.$repo.$/route.tsx', import.meta.url)),
    'utf8'
  );

  test('refuses with the ordinary answer', () => {
    expect(source).toContain('pageDocumentDecision(');
    expect(source).toContain("if (pageDecision.outcome === 'refuse') throw forbidden();");
  });

  test('decides before the deck rule and before any read', () => {
    const at = source.indexOf('pageDocumentDecision(');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(source.indexOf('deckDocumentDecision({'));
    expect(at).toBeLessThan(source.indexOf('fetchProxyText(matched'));
    expect(at).toBeLessThan(source.indexOf('await fetchContent({ org, repo, path, binary'));
  });

  test('holds the path to its repo-root spelling before anything else', () => {
    const at = source.indexOf('canonicalProxyPath(');
    expect(at).toBeGreaterThan(-1);
    expect(source).toContain('ClassmojiService.contentDelivery.normalizeRepoRelative');
    expect(source).toContain('if (!path) throw forbidden();');
    expect(at).toBeLessThan(source.indexOf('getAuthSession(request)'));
    expect(at).toBeLessThan(source.indexOf('slideDocumentDecision('));
    expect(at).toBeLessThan(source.indexOf('pageDocumentDecision('));
    // Nothing after the gate reads the raw splat.
    expect(source.match(/rawPath/g)?.length).toBe(3);
  });

  test('matches stored folders in every form', () => {
    expect(
      source.match(/content_path: \{ in: storedContentPathForms\(contentPath\) \}/g)
    ).toHaveLength(2);
  });

  test('looks pages up in the authorized classrooms and every classroom on this repo', () => {
    const start = source.indexOf('pageDocumentDecision({');
    const block = source.slice(start, source.indexOf("if (pageDecision.outcome === 'refuse')"));
    expect(block).toContain('authorizedClassroomIds');
    expect(block).toContain('git_organization: { login: org }');
    expect(block).toContain('expectedContentRepo(page.classroom) === repo');
  });
});
