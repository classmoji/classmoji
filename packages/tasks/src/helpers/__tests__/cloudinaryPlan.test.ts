/**
 * The migration plan: inventory by asset, per-classroom cost, the work list,
 * what is reported and never rewritten — and that planning is read-only.
 */

import { describe, expect, it, vi } from 'vitest';

import {
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
