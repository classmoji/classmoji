/**
 * The migration plan: inventory by asset, per-classroom cost, the work list,
 * what is reported and never rewritten — and that planning is read-only.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_LOOKUPS,
  buildPlan,
  planMigration,
  type ClassroomFacts,
  type CloudinaryAsset,
  type DeckRecord,
  type PlanReadDeps,
} from '../cloudinaryPlan.ts';

const CLOUD = 'classmoji-test';
const GIB = 1024 ** 3;
const url = (id: string) =>
  `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/${id}?_a=BAMAOGfm0`;

const A = 'classmoji/slides/s1/aaaa';
const B = 'classmoji/slides/s2/bbbb';
const C = 'classmoji/slides/s3/cccc';

const asset = (publicId: string, bytes: number): CloudinaryAsset => ({
  publicId,
  format: 'mp4',
  bytes,
  version: 1,
  secureUrl: `https://res.cloudinary.com/${CLOUD}/video/upload/v1/${publicId}.mp4`,
  createdAt: null,
});

const deck = (slideId: string, classroomId: string, createdBy = 'owner-1'): DeckRecord => ({
  slideId,
  classroomId,
  title: slideId,
  contentPath: `slides/${slideId}`,
  createdBy,
});

const facts = (classroomId: string, over: Partial<ClassroomFacts> = {}): ClassroomFacts => ({
  classroomId,
  slug: classroomId,
  name: classroomId,
  isArchived: false,
  status: 'ACTIVE',
  isPro: true,
  usedBytes: 0,
  canServeMedia: true,
  gitProvider: 'GITHUB',
  gitOrgLogin: 'org',
  contentRepo: 'content',
  ...over,
});

const files = (slideId: string, deckJson: string, html = '') => [
  { path: `slides/${slideId}/deck.json`, sha: `sha-${slideId}-json`, text: deckJson },
  ...(html
    ? [{ path: `slides/${slideId}/index.html`, sha: `sha-${slideId}-html`, text: html }]
    : []),
];

function fixture() {
  return {
    cloudName: CLOUD,
    proQuotaBytes: 10 * GIB,
    assets: [asset(A, 100), asset(B, 200), asset(C, 300)],
    classrooms: [
      facts('room-1', { usedBytes: 10 * GIB - 150 }),
      facts('room-2', { isPro: false, isArchived: true }),
    ],
    scanned: [
      {
        deck: deck('d1', 'room-1', 'alice'),
        read: {
          files: files(
            'd1',
            JSON.stringify({ attrs: { 'data-background-video': url(A) } }),
            `<section data-background-video="${url(A)}"><video src="${url(B)}"></video></section>`
          ),
          previewFiles: [],
          previewBranch: null,
          unscanned: null,
        },
      },
      {
        // An imported copy in another classroom still pointing at A.
        deck: deck('d2', 'room-2', 'bob'),
        read: {
          files: files('d2', JSON.stringify({ src: url(A) })),
          previewFiles: [
            {
              path: 'slides/d2/deck.json',
              sha: 'p',
              text: JSON.stringify({ src: url(B) }),
            },
          ],
          previewBranch: 'preview/slides/d2',
          unscanned: null,
        },
      },
      {
        deck: deck('d3', 'room-2'),
        read: {
          files: [],
          previewFiles: [],
          previewBranch: null,
          unscanned: 'no deck.json or index.html',
        },
      },
      {
        deck: deck('d4', 'room-1'),
        read: {
          files: files(
            'd4',
            `<img src="https://res.cloudinary.com/${CLOUD}/video/upload/so_1/v1/${A}.jpg">` +
              `<video src="https://res.cloudinary.com/${CLOUD}/video/upload/v1/classmoji/slides/zz/gone">`
          ),
          previewFiles: [],
          previewBranch: null,
          unscanned: null,
        },
      },
    ],
    generatedAt: '2026-09-27T00:00:00.000Z',
  };
}

describe('buildPlan', () => {
  it('inventories by asset, with referencing decks and the unreferenced flag', () => {
    const plan = buildPlan(fixture());
    const byId = new Map(plan.assets.map(a => [a.publicId, a]));
    expect(byId.get(A)?.classroomIds).toEqual(['room-1', 'room-2']);
    expect(byId.get(A)?.referencedBy).toEqual([
      {
        slideId: 'd1',
        classroomId: 'room-1',
        path: 'slides/d1/deck.json',
        count: 1,
        background: 1,
      },
      {
        slideId: 'd1',
        classroomId: 'room-1',
        path: 'slides/d1/index.html',
        count: 1,
        background: 1,
      },
      {
        slideId: 'd2',
        classroomId: 'room-2',
        path: 'slides/d2/deck.json',
        count: 1,
        background: 0,
      },
    ]);
    expect(byId.get(B)?.unreferenced).toBe(false);
    expect(byId.get(C)).toMatchObject({ unreferenced: true, classroomIds: [] });
  });

  it('makes one work item per (asset, classroom), owner of the first deck as uploader', () => {
    const plan = buildPlan(fixture());
    expect(plan.work).toEqual([
      { publicId: A, classroomId: 'room-1', bytes: 100, slideIds: ['d1'], uploadedBy: 'alice' },
      { publicId: A, classroomId: 'room-2', bytes: 100, slideIds: ['d2'], uploadedBy: 'bob' },
      { publicId: B, classroomId: 'room-1', bytes: 200, slideIds: ['d1'], uploadedBy: 'alice' },
    ]);
  });

  it('costs each classroom against the Pro quota and flags over-quota', () => {
    const plan = buildPlan(fixture());
    const room1 = plan.classrooms.find(c => c.classroomId === 'room-1');
    expect(room1).toMatchObject({
      isPro: true,
      headroomBytes: 150,
      bytesToAdd: 300,
      overQuota: true,
      decks: ['d1'],
    });
    const room2 = plan.classrooms.find(c => c.classroomId === 'room-2');
    expect(room2).toMatchObject({
      isPro: false,
      isArchived: true,
      bytesToAdd: 100,
      overQuota: false,
    });
  });

  it('reports stills, unknown ids, preview branches and unreadable decks', () => {
    const plan = buildPlan(fixture());
    expect(plan.otherReferences.map(r => [r.kind, r.publicId])).toEqual([
      ['still', A],
      ['unknown', 'classmoji/slides/zz/gone'],
    ]);
    expect(plan.previewReferences).toEqual([
      {
        slideId: 'd2',
        classroomId: 'room-2',
        branch: 'preview/slides/d2',
        path: 'slides/d2/deck.json',
        publicIds: [B],
      },
    ]);
    expect(plan.unscannedDecks).toEqual([
      { slideId: 'd3', classroomId: 'room-2', reason: 'no deck.json or index.html' },
    ]);
  });

  it('totals, including data-background-video references', () => {
    expect(buildPlan(fixture()).totals).toEqual({
      assets: 3,
      assetBytes: 600,
      referencedAssets: 2,
      unreferencedAssets: 1,
      unreferencedBytes: 300,
      decksScanned: 3,
      decksWithReferences: 3,
      decksUnscanned: 1,
      classroomsAffected: 2,
      workItems: 3,
      bytesToCopy: 400,
      overQuotaClassrooms: 1,
      otherFolderAssets: 0,
      lookups: 0,
      videoReferences: 4,
      backgroundVideoReferences: 2,
      otherReferences: 2,
      previewBranchesWithReferences: 1,
    });
  });

  it('lists classrooms whose media cannot render as blocked', () => {
    const input = fixture();
    input.classrooms[1] = facts('room-2', { canServeMedia: false });
    expect(buildPlan(input).blockedClassrooms).toEqual(['room-2']);
  });

  it('applies limit to the work list only', () => {
    const plan = buildPlan({ ...fixture(), limit: 1 });
    expect(plan.work).toHaveLength(1);
    expect(plan.workDeferredByLimit).toBe(2);
    expect(plan.totals.workItems).toBe(3);
  });
});

describe('planMigration', () => {
  function readDeps(): PlanReadDeps {
    const input = fixture();
    const reads = new Map(input.scanned.map(s => [s.deck.slideId, s.read]));
    return {
      cloudName: CLOUD,
      proQuotaBytes: 10 * GIB,
      listCloudinaryAssets: vi.fn(async () => input.assets),
      lookupCloudinaryAsset: vi.fn(async () => null),
      listDecks: vi.fn(async () => input.scanned.map(s => s.deck)),
      classroomFacts: vi.fn(async () => input.classrooms),
      readDeck: vi.fn(async (d: DeckRecord) => {
        if (d.slideId === 'd4') throw new Error('HTTP 403');
        return reads.get(d.slideId)!;
      }),
      now: () => new Date('2026-09-27T00:00:00.000Z'),
    };
  }

  it('builds the plan from its reads, and a failed deck read is unscanned, not fatal', async () => {
    const deps = readDeps();
    const plan = await planMigration(deps);
    expect(deps.classroomFacts).toHaveBeenCalledWith(['room-1', 'room-2']);
    expect(deps.readDeck).toHaveBeenCalledTimes(4);
    expect(plan.unscannedDecks.map(d => d.slideId).sort()).toEqual(['d3', 'd4']);
    expect(plan.unscannedDecks.find(d => d.slideId === 'd4')?.reason).toBe('read failed: HTTP 403');
    expect(plan.generatedAt).toBe('2026-09-27T00:00:00.000Z');
  });

  it('passes limit through', async () => {
    const plan = await planMigration(readDeps(), { limit: 2 });
    expect(plan.work).toHaveLength(2);
  });
});

describe('videos outside classmoji/slides/ (plan §13.5)', () => {
  const HOST = `https://res.cloudinary.com/${CLOUD}/video/upload`;
  const TEAM = 'cs52-projects/team-a';
  const team = { ...asset(TEAM, 5000), format: 'mov' };

  function deps(deckText: string, lookup: (id: string) => Promise<CloudinaryAsset | null>) {
    const d = deck('welcome', 'room-1', 'alice');
    return {
      cloudName: CLOUD,
      proQuotaBytes: 10 * GIB,
      listCloudinaryAssets: async () => [asset(A, 100)],
      lookupCloudinaryAsset: vi.fn(lookup),
      listDecks: async () => [d],
      classroomFacts: async () => [facts('room-1')],
      readDeck: async () => ({
        files: files('welcome', deckText),
        previewFiles: [],
        previewBranch: null,
        unscanned: null,
      }),
      now: () => new Date('2026-09-27T00:00:00.000Z'),
    } satisfies PlanReadDeps;
  }

  const text = JSON.stringify({
    slides: [
      { src: `${HOST}/q_auto/v1712345678/${TEAM}.mp4` },
      { src: `${HOST}/v1712345678/${TEAM}.mov` },
      { poster: `${HOST}/so_1/${TEAM}.jpg` },
      { src: `${HOST}/v1/cs52-projects/missing.mp4` },
      { src: `${HOST}/v1/cs52-projects/boom.mp4` },
      { src: `${HOST}/v1/classmoji/slides/zz/gone` },
      { src: url(A) },
    ],
  });
  const lookup = async (id: string) => {
    if (id === TEAM) return team;
    if (id.startsWith('cs52-projects/boom')) throw new Error('Cloudinary lookup failed: HTTP 500');
    return null;
  };

  it('resolves an unlisted public_id once and makes it an other-folder asset', async () => {
    const d = deps(text, lookup);
    const plan = await planMigration(d);
    const other = plan.assets.find(a => a.publicId === TEAM);
    expect(other).toMatchObject({
      source: 'other-folder',
      bytes: 5000,
      format: 'mov',
      secureUrl: team.secureUrl,
      unreferenced: false,
      classroomIds: ['room-1'],
    });
    // .mp4 and .mov are two delivery formats of ONE asset: both references count.
    expect(other?.referencedBy).toEqual([
      {
        slideId: 'welcome',
        classroomId: 'room-1',
        path: 'slides/welcome/deck.json',
        count: 2,
        background: 0,
      },
    ]);
    expect(plan.assets.find(a => a.publicId === A)?.source).toBe('classmoji-folder');
    expect(plan.work.map(w => w.publicId)).toEqual([A, TEAM]);
    const calls = d.lookupCloudinaryAsset.mock.calls.map(c => c[0]);
    expect(calls.filter(id => id === TEAM)).toHaveLength(1);
    // The listing is complete under the prefix: an unlisted id there is not looked up.
    expect(calls.some(id => id.startsWith('classmoji/slides/'))).toBe(false);
    expect(plan.totals).toMatchObject({ otherFolderAssets: 1, lookups: calls.length });
  });

  it('keeps stills reported and only unfindable ids in otherReferences, each with a reason', async () => {
    const plan = await planMigration(deps(text, lookup));
    expect(plan.otherReferences.map(r => [r.kind, r.publicId, r.reason])).toEqual([
      ['still', TEAM, 'a still frame of the video, not the video; not rewritten'],
      ['unknown', 'cs52-projects/missing', 'no Cloudinary video with this public_id'],
      ['unknown', 'cs52-projects/boom', 'lookup failed: Cloudinary lookup failed: HTTP 500'],
      [
        'unknown',
        'classmoji/slides/zz/gone',
        'not in the classmoji/slides/ listing (deleted from Cloudinary)',
      ],
    ]);
  });

  it('does not add an asset only a still frame points at', async () => {
    const plan = await planMigration(
      deps(JSON.stringify({ poster: `${HOST}/so_1/${TEAM}.jpg` }), lookup)
    );
    expect(plan.assets.map(a => a.publicId)).toEqual([A]);
    expect(plan.otherReferences.map(r => r.kind)).toEqual(['still']);
  });

  it('caps lookups per plan and says so', async () => {
    const many = JSON.stringify(
      Array.from({ length: MAX_LOOKUPS + 5 }, (_, i) => `${HOST}/v1/other/v${i}`)
    );
    const d = deps(many, async () => null);
    const plan = await planMigration(d);
    expect(d.lookupCloudinaryAsset).toHaveBeenCalledTimes(MAX_LOOKUPS);
    expect(plan.otherReferences.at(-1)?.reason).toMatch(/not looked up: over 200 lookups/);
  });
});
