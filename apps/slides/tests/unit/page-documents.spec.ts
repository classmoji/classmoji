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
import { pageDocumentDecision, pageDocumentFolderOf } from '../../app/utils/slideDocumentAccess.ts';

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

  test('looks pages up in the authorized classrooms and every classroom on this repo', () => {
    const start = source.indexOf('pageDocumentDecision({');
    const block = source.slice(start, source.indexOf("if (pageDecision.outcome === 'refuse')"));
    expect(block).toContain('authorizedClassroomIds');
    expect(block).toContain('git_organization: { login: org }');
    expect(block).toContain('expectedContentRepo(page.classroom) === repo');
  });
});
