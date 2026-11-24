/**
 * Legacy pages (index.html, no content.json) are converted nowhere at request
 * time, not on read and not by collab (utils/legacyPage.ts). The pure rules, the git probe and the two content
 * reads are called directly (their I/O swapped for fakes). Who gets which
 * notice from the real loaders is in `legacy-pages-loader.spec.ts`; what is
 * left here as source pins is the client's gating and the cover intents'
 * error mapping (an action that needs Postgres to reach).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  LEGACY_PAGE_NOTICE,
  LEGACY_PAGE_WRITE_REFUSAL,
  LegacyPageFormatError,
  emptyPageDocument,
  legacyPageRule,
} from '~/utils/legacyPage.ts';
import { importWithStubs, stubModule } from '../helpers/dataRequest.helpers.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const LOADER_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
const ROUTE_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.tsx');
const SITE_PAGE_SOURCE = source('../../app/site/page.tsx');
const SITE_HOME_SOURCE = source('../../app/site/home.tsx');
const SITE_RENDER_SOURCE = source('../../app/site/pageRender.server.ts');

test.describe('the rule', () => {
  test('staff get the notice; nobody who could edit gets an editor (live or git)', () => {
    expect(legacyPageRule({ legacyInGit: true, staff: true, canEdit: true })).toEqual({
      notice: true,
      readOnly: true,
    });
    // An assistant: told, but has no editor to withhold.
    expect(legacyPageRule({ legacyInGit: true, staff: true, canEdit: false })).toEqual({
      notice: true,
      readOnly: false,
    });
    expect(legacyPageRule({ legacyInGit: true, staff: false, canEdit: false })).toEqual({
      notice: false,
      readOnly: false,
    });
    expect(legacyPageRule({ legacyInGit: false, staff: true, canEdit: true })).toEqual({
      notice: false,
      readOnly: false,
    });
  });

  test('the document shown is one empty paragraph, a fresh one each time', () => {
    const a = emptyPageDocument();
    expect(a).toEqual([{ type: 'paragraph', content: [] }]);
    expect(emptyPageDocument()).not.toBe(a);
  });

  test('the copy', () => {
    expect(LEGACY_PAGE_NOTICE).toBe("This page is in an old format and can't be shown.");
    const error = new LegacyPageFormatError();
    expect(error.status).toBe(422);
    expect(error.message).toBe(LEGACY_PAGE_WRITE_REFUSAL);
  });
});

test.describe('is the page legacy in git (the probe before the live room is asked)', () => {
  const page = {
    content_path: 'pages/week-1',
    classroom: {
      id: 'c',
      content_repo: 'content-cs1',
      git_organization: { provider: 'GITHUB', login: 'org' },
    },
  };

  async function probe() {
    return importWithStubs<typeof import('~/utils/legacyPage.server.ts')>(
      new URL('../../app/utils/legacyPage.server.ts', import.meta.url),
      {
        '/app/utils/db.server.ts': stubModule('export const prisma = {};'),
        '@classmoji/services': stubModule('export const ContentService = {};'),
      }
    );
  }

  test('the asset map answers first; git only when the map has neither file', async () => {
    const { pageIsLegacyInGit } = await probe();
    const asked: string[] = [];
    const exists = async (path: string) => {
      asked.push(path);
      return path.endsWith('index.html');
    };
    expect(
      await pageIsLegacyInGit(page, { mapPaths: async () => ['pages/week-1/index.html'], exists })
    ).toBe(true);
    expect(
      await pageIsLegacyInGit(page, {
        mapPaths: async () => ['pages/week-1/index.html', 'pages/week-1/content.json'],
        exists,
      })
    ).toBe(false);
    expect(asked).toEqual([]);
    expect(await pageIsLegacyInGit(page, { mapPaths: async () => [], exists })).toBe(true);
    expect(asked).toEqual(['pages/week-1/content.json', 'pages/week-1/index.html']);
  });

  test('a failure answers false (git’s own read decides)', async () => {
    const { pageIsLegacyInGit } = await probe();
    expect(
      await pageIsLegacyInGit(page, {
        mapPaths: async () => {
          throw new Error('db down');
        },
      })
    ).toBe(false);
  });
});

test.describe('the notice', () => {
  // The runner compiles JSX to its component-testing objects, so a `.tsx`
  // component cannot be rendered here (see forms-admin-tabs.spec.ts): its
  // markup is read from source.
  const NOTICE_SOURCE = source('../../app/components/LegacyPageNotice.tsx');

  test('the one copy, the app’s amber notice look, in light and dark', () => {
    expect(NOTICE_SOURCE).toContain('{LEGACY_PAGE_NOTICE}');
    expect(NOTICE_SOURCE).not.toContain('kind');
    expect(NOTICE_SOURCE.match(/data-testid="legacy-page-notice"/g)).toHaveLength(2);
    for (const cls of [
      'bg-amber-50',
      'dark:bg-amber-950/90',
      'text-amber-900',
      'dark:text-amber-100',
    ]) {
      expect(NOTICE_SOURCE, cls).toContain(cls);
    }
    // Plain markup: the class site renders it with no client bundle.
    expect(NOTICE_SOURCE).not.toMatch(/use(State|Effect|Ref)\(|onClick/);
  });
});

test.describe('the in-app page route', () => {
  test('no conversion is left in the loader', () => {
    expect(LOADER_SOURCE).not.toContain('migration.server');
    expect(LOADER_SOURCE).not.toContain('migrateHtmlToBlockNote');
    expect(LOADER_SOURCE).not.toContain('@classmoji/page-schema/html');
  });

  test('both cover intents answer the cover refusal with its own status', () => {
    const answers = LOADER_SOURCE.match(
      /if \(error instanceof LegacyPageFormatError\) \{\n\s+return Response\.json\(\{ error: error\.message \}, \{ status: error\.status \}\);/g
    );
    expect(answers).toHaveLength(2);
  });

  test('the client withholds the editor, and draws the notice it was given', () => {
    expect(ROUTE_SOURCE).toContain(
      'const canEdit = canEditRole && !isPreview && !liveUnavailable && !legacyReadOnly;'
    );
    expect(ROUTE_SOURCE).toContain(
      '{legacyNotice && <LegacyPageNotice layout="bar" isEmbedded={isEmbedded} />}'
    );
  });

  test('the loader joins no live room for a legacy page', () => {
    expect(LOADER_SOURCE).toContain(
      'const collab: CollabLoaderData | null = legacyReadOnly ? null : liveCollab;'
    );
  });
});

test.describe('the cover save', () => {
  const page = { id: 'p', title: 'Old', content_path: 'pages/old', classroom: {} } as never;

  async function contentServer() {
    return importWithStubs<typeof import('~/utils/content.server.ts')>(
      new URL('../../app/utils/content.server.ts', import.meta.url),
      { '/app/utils/db.server.ts': stubModule('export const ClassmojiService = {};') }
    );
  }

  test('refuses a legacy page before anything is written', async () => {
    const { savePageCoverImage } = await contentServer();
    let saved = 0;
    const attempt = savePageCoverImage(
      page,
      { url: 'pages/old/assets/c.png', position: 50 },
      {
        load: async () => ({ format: 'html', content: '<p>old</p>', coverImage: null, sha: 's' }),
        save: async () => {
          saved += 1;
          return { sha: 'x', commit: 'y' };
        },
      }
    );
    await expect(attempt).rejects.toMatchObject({ name: 'LegacyPageFormatError', status: 422 });
    expect(saved).toBe(0);
  });

  test('still writes a content.json page, locked on its sha', async () => {
    const { savePageCoverImage } = await contentServer();
    const calls: unknown[] = [];
    const result = await savePageCoverImage(
      page,
      { url: 'pages/old/assets/c.png', position: 50 },
      {
        load: async () => ({
          format: 'json',
          content: [{ type: 'paragraph' }],
          coverImage: null,
          sha: 'j1',
        }),
        save: async (...args: unknown[]) => {
          calls.push(args);
          return { sha: 'j2', commit: 'c' };
        },
      }
    );
    expect(result).toEqual({ sha: 'j2' });
    expect(calls).toEqual([
      [
        page,
        [{ type: 'paragraph' }],
        { coverImage: { url: 'pages/old/assets/c.png', position: 50 }, expectedSha: 'j1' },
      ],
    ]);
  });
});

test.describe('the class site', () => {
  const classroom = {
    id: 'c',
    content_key_version: 1,
    content_delivery_enabled: false,
    content_repo: 'content-cs1',
    git_organization: { login: 'org' },
  };

  async function siteContent() {
    return importWithStubs<typeof import('~/site/content.server.ts')>(
      new URL('../../app/site/content.server.ts', import.meta.url),
      {
        '@classmoji/services': stubModule(
          'export const ClassmojiService = {}; export const ContentService = {};'
        ),
      }
    );
  }

  test('a legacy page loads as an empty article, its HTML never read into the payload', async () => {
    const { loadSitePageContent } = await siteContent();
    const asked: string[] = [];
    const content = await loadSitePageContent(
      { content_path: 'pages/old', title: 'Old' },
      classroom,
      async (_classroom, _login, _repo, path) => {
        asked.push(path);
        return path.endsWith('index.html') ? { content: '<p>SECRET-OLD-BODY</p>', sha: 's' } : null;
      }
    );
    expect(asked).toEqual(['pages/old/content.json', 'pages/old/index.html']);
    expect(content).toEqual({ format: 'html', blocks: [], coverImage: null });
    expect(JSON.stringify(content)).not.toContain('SECRET-OLD-BODY');
  });

  test('a content.json page is unchanged', async () => {
    const { loadSitePageContent } = await siteContent();
    const content = await loadSitePageContent(
      { content_path: 'pages/new' },
      classroom,
      async (_c, _l, _r, path) =>
        path.endsWith('content.json')
          ? { content: JSON.stringify({ blocks: [{ type: 'paragraph' }] }), sha: 's' }
          : null
    );
    expect(content).toEqual({ format: 'json', blocks: [{ type: 'paragraph' }], coverImage: null });
  });

  test('a content.json that exists but is empty is an error, never a legacy page', async () => {
    const { loadSitePageContent } = await siteContent();
    const asked: string[] = [];
    await expect(
      loadSitePageContent({ content_path: 'pages/big' }, classroom, async (_c, _l, _r, path) => {
        asked.push(path);
        return path.endsWith('content.json')
          ? { content: '', sha: 's' }
          : { content: '<p>old</p>', sha: 'h' };
      })
    ).rejects.toThrow(/not valid JSON/);
    expect(asked).toEqual(['pages/big/content.json']);
  });

  test('the notice is staff-only on both site routes, from the render’s flag', () => {
    expect(SITE_RENDER_SOURCE).toContain("legacyFormat: content.format === 'html',");
    for (const route of [SITE_PAGE_SOURCE, SITE_HOME_SOURCE]) {
      expect(route).toContain('legacyNotice: isStaff(viewer) && view.legacyFormat,');
      expect(route).toContain('{legacyNotice ? <LegacyPageNotice layout="inline" /> : null}');
    }
  });
});
