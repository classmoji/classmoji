/**
 * The report-only non-deck sweep: which URLs count as ours, the SELECT it
 * builds (allowlisted tables only), and that one bad page or table never
 * stops the rest.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  NON_DECK_TABLES,
  assertNonDeckTable,
  nonDeckQuery,
  ourCloudUrls,
  sweepNonDeck,
  type NonDeckTable,
  type PageRecord,
} from '../cloudinaryNonDeck.ts';

const CLOUD = 'classmoji-test';
const OURS_VIDEO = `https://res.cloudinary.com/${CLOUD}/video/upload/q_auto/v1/cs52/intro.mp4`;
const OURS_IMAGE = `https://res.cloudinary.com/${CLOUD}/image/upload/c_fill,w_100/logo.png`;
const THEIRS = 'https://res.cloudinary.com/someone-else/video/upload/v1/x.mp4';

describe('ourCloudUrls', () => {
  it('finds image and video URLs of our cloud only, deduplicated', () => {
    const text = `<img src="${OURS_IMAGE}"> [v](${OURS_VIDEO}) ${THEIRS} ${OURS_VIDEO}`;
    expect(ourCloudUrls(text, CLOUD)).toEqual([OURS_IMAGE, OURS_VIDEO]);
  });
});

describe('nonDeckQuery', () => {
  it('is a SELECT over an allowlisted table, pattern as a parameter', () => {
    expect(nonDeckQuery('modules')).toBe(
      'SELECT to_jsonb(t) AS row FROM "modules" t WHERE to_jsonb(t)::text ILIKE $1'
    );
    for (const table of NON_DECK_TABLES) expect(nonDeckQuery(table)).toMatch(/^SELECT /);
  });

  it('refuses a table outside the allowlist (it is interpolated)', () => {
    expect(() => assertNonDeckTable('classroom_settings')).toThrow(/not a swept table/);
    expect(() => nonDeckQuery('users"; DROP TABLE x; --' as NonDeckTable)).toThrow();
  });
});

describe('sweepNonDeck', () => {
  const page = (pageId: string): PageRecord => ({
    pageId,
    classroomId: 'room-1',
    title: pageId,
    contentPath: `pages/${pageId}`,
  });

  it('reports page files and database columns, and keeps going past failures', async () => {
    const queryTable = vi.fn(async (table: NonDeckTable) => {
      if (table === 'forms') throw new Error('relation "forms" does not exist');
      if (table === 'calendar_events') {
        return [
          {
            id: 'ev-1',
            classroom_id: 'room-1',
            title: 'Lecture',
            meeting_link: OURS_VIDEO,
            recurrence_rule: null,
          },
        ];
      }
      if (table === 'form_revisions') {
        return [{ id: 'rev-1', form_id: 'f-1', fields: [{ label: 'x', help: OURS_IMAGE }] }];
      }
      return [];
    });
    const sweep = await sweepNonDeck(
      {
        cloudName: CLOUD,
        readPage: async p => {
          if (p.pageId === 'broken') throw new Error('HTTP 500');
          if (p.pageId === 'gitlab') return { files: [], unscanned: 'provider GITLAB' };
          return {
            files: [
              { path: `${p.contentPath}/content.json`, text: `{"src":"${OURS_VIDEO}"}` },
              { path: `${p.contentPath}/index.html`, text: `<img src="${THEIRS}">` },
            ],
            unscanned: null,
          };
        },
        queryTable,
      },
      [page('ok'), page('broken'), page('gitlab')]
    );

    expect(queryTable).toHaveBeenCalledTimes(NON_DECK_TABLES.length);
    expect(sweep.references).toEqual([
      {
        source: 'page-file',
        classroomId: 'room-1',
        pageId: 'ok',
        title: 'ok',
        path: 'pages/ok/content.json',
        urls: [OURS_VIDEO],
      },
      {
        source: 'db',
        table: 'form_revisions',
        column: 'fields',
        rowId: 'rev-1',
        classroomId: null,
        urls: [OURS_IMAGE],
      },
      {
        source: 'db',
        table: 'calendar_events',
        column: 'meeting_link',
        rowId: 'ev-1',
        classroomId: 'room-1',
        urls: [OURS_VIDEO],
      },
    ]);
    expect(sweep.unscanned).toEqual([
      { location: 'page broken (pages/broken)', reason: 'read failed: HTTP 500' },
      { location: 'page gitlab (pages/gitlab)', reason: 'provider GITLAB' },
      { location: 'table forms', reason: 'relation "forms" does not exist' },
    ]);
  });
});
