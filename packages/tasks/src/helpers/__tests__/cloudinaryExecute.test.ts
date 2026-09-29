/**
 * `executeMigration` against fakes only — it is never run for real in this
 * pass. What is pinned: the system-import row, Cloudinary once then R2 copy,
 * HEAD through the delivery origin BEFORE any rewrite, only verified copies
 * rewritten, sha conflicts re-read and re-applied, and a second run doing
 * nothing.
 */

import { describe, expect, it } from 'vitest';

import { buildPlan, type ClassroomFacts, type CloudinaryAsset } from '../cloudinaryPlan.ts';
import { COMMIT_TRIES, executeMigration, type ExecuteDeps } from '../cloudinaryExecute.ts';

const CLOUD = 'classmoji-test';
const A = 'classmoji/slides/s1/aaaa';
const B = 'classmoji/slides/s2/bbbb';
const url = (id: string) =>
  `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/${id}?_a=BAMAOGfm0`;

const asset = (publicId: string, bytes: number): CloudinaryAsset => ({
  publicId,
  format: 'mp4',
  bytes,
  version: 1,
  secureUrl: `https://res.cloudinary.com/${CLOUD}/video/upload/v1/${publicId}.mp4`,
  createdAt: null,
});

const facts = (classroomId: string): ClassroomFacts => ({
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
});

function initialRepo(): Map<string, { text: string; sha: string }> {
  return new Map([
    [
      'room-1:slides/d1/deck.json',
      {
        text: JSON.stringify({ attrs: { 'data-background-video': url(A) }, v: url(B) }),
        sha: 'j1',
      },
    ],
    [
      'room-1:slides/d1/index.html',
      {
        text: `<section data-background-video="${url(A)}"><video src="${url(B)}"></video>`,
        sha: 'h1',
      },
    ],
    ['room-2:slides/d2/deck.json', { text: JSON.stringify({ src: url(A) }), sha: 'j2' }],
  ]);
}

function planFor(repo: Map<string, { text: string; sha: string }>) {
  const read = (classroomId: string, slideId: string) => ({
    files: [...repo]
      .filter(([key]) => key.startsWith(`${classroomId}:slides/${slideId}/`))
      .map(([key, file]) => ({ path: key.slice(classroomId.length + 1), ...file })),
    previewFiles: [],
    previewBranch: null,
    unscanned: null,
  });
  return buildPlan({
    cloudName: CLOUD,
    proQuotaBytes: 10 * 1024 ** 3,
    assets: [asset(A, 100), asset(B, 200)],
    classrooms: [facts('room-1'), facts('room-2')],
    scanned: [
      {
        deck: {
          slideId: 'd1',
          classroomId: 'room-1',
          title: 'd1',
          contentPath: 'slides/d1',
          createdBy: 'alice',
        },
        read: read('room-1', 'd1'),
      },
      {
        deck: {
          slideId: 'd2',
          classroomId: 'room-2',
          title: 'd2',
          contentPath: 'slides/d2',
          createdBy: 'bob',
        },
        read: read('room-2', 'd2'),
      },
    ],
    generatedAt: '2026-09-27T00:00:00.000Z',
  });
}

interface World {
  repo: Map<string, { text: string; sha: string }>;
  rows: Map<string, { id: string; classroom_id: string; status: string; row?: unknown }>;
  objects: Map<string, number>;
  events: string[];
  /** Commits that should lose a race: the fake changes the file first. */
  conflicts: number;
  headStatus: number;
  canServe: Set<string>;
}

function world(): World {
  return {
    repo: initialRepo(),
    rows: new Map(),
    objects: new Map(),
    events: [],
    conflicts: 0,
    headStatus: 200,
    canServe: new Set(['room-1', 'room-2']),
  };
}

function fakeDeps(w: World): ExecuteDeps {
  let shaCounter = 0;
  return {
    cloudName: CLOUD,
    mediaIdFor: (publicId, classroomId) => `id(${publicId}@${classroomId})`,
    mediaKey: (classroomId, mediaId, variant) => `m/${classroomId}/${mediaId}/${variant}`,
    contentTypeFor: ext => (ext === 'mp4' ? 'video/mp4' : 'application/octet-stream'),
    canServeMedia: async classroomId => w.canServe.has(classroomId),
    findMediaRow: async id => w.rows.get(id) ?? null,
    reserveRow: async row => {
      w.events.push(`reserve ${row.id}`);
      w.rows.set(row.id, { id: row.id, classroom_id: row.classroomId, status: 'UPLOADING', row });
    },
    releaseRow: async id => {
      w.events.push(`release ${id}`);
      if (w.rows.get(id)?.status === 'UPLOADING') w.rows.delete(id);
    },
    markReady: async id => {
      const row = w.rows.get(id);
      if (row?.status !== 'UPLOADING') return false;
      row.status = 'READY';
      w.events.push(`ready ${id}`);
      return true;
    },
    onMediaReady: async id => {
      w.events.push(`onMediaReady ${id}`);
    },
    makeTmpDir: async () => '/tmp/fake',
    removeTmpDir: async () => {},
    downloadOriginal: async a => {
      w.events.push(`download ${a.publicId}`);
    },
    putObject: async (key, _file, size) => {
      w.events.push(`put ${key}`);
      w.objects.set(key, size);
    },
    copyObject: async (from, to) => {
      w.events.push(`copy ${from} -> ${to}`);
      const size = w.objects.get(from);
      if (size === undefined) throw new Error('NoSuchKey');
      w.objects.set(to, size);
    },
    headObject: async key => w.objects.get(key) ?? null,
    deleteObject: async key => {
      w.events.push(`delete ${key}`);
      w.objects.delete(key);
    },
    servedUrl: async (classroomId, id) =>
      `https://content.test/c/${classroomId}/media/${encodeURIComponent(id)}`,
    headUrl: async u => {
      w.events.push(`HEAD ${u}`);
      const id = decodeURIComponent(u.slice(u.lastIndexOf('/') + 1));
      const row = w.rows.get(id) as { row?: { sizeBytes: number } } | undefined;
      return { status: w.headStatus, length: row?.row?.sizeBytes ?? null };
    },
    readDeckFile: async (classroomId, path) => w.repo.get(`${classroomId}:${path}`) ?? null,
    commitDeckFiles: async (classroomId, files, expected) => {
      if (w.conflicts > 0) {
        w.conflicts--;
        // Somebody else saved the deck in between: same URLs, new sha.
        const key = `${classroomId}:${files[0]!.path}`;
        const current = w.repo.get(key)!;
        w.repo.set(key, { text: `${current.text} `, sha: `other-${shaCounter++}` });
      }
      for (const file of files) {
        if (w.repo.get(`${classroomId}:${file.path}`)?.sha !== expected[file.path]) {
          w.events.push(`conflict ${classroomId}:${file.path}`);
          return 'conflict';
        }
      }
      for (const file of files) {
        w.repo.set(`${classroomId}:${file.path}`, { text: file.text, sha: `new-${shaCounter++}` });
      }
      w.events.push(`commit ${classroomId} ${files.map(f => f.path).join(',')}`);
      return 'committed';
    },
  };
}

describe('executeMigration', () => {
  it('uploads once from Cloudinary, copies in R2 for the second classroom, and records the system import', async () => {
    const w = world();
    const report = await executeMigration(planFor(w.repo), fakeDeps(w));

    expect(w.events.filter(e => e.startsWith('download'))).toEqual([
      `download ${A}`,
      `download ${B}`,
    ]);
    expect(w.events).toContain(
      `copy m/room-1/id(${A}@room-1)/orig.mp4 -> m/room-2/id(${A}@room-2)/orig.mp4`
    );
    expect(report.items.map(i => [i.publicId, i.classroomId, i.outcome])).toEqual([
      [A, 'room-1', 'uploaded'],
      [A, 'room-2', 'copied'],
      [B, 'room-1', 'uploaded'],
    ]);
    const row = w.rows.get(`id(${A}@room-1)`)!;
    expect(row.status).toBe('READY');
    expect(row.row).toEqual({
      id: `id(${A}@room-1)`,
      classroomId: 'room-1',
      filename: 'aaaa.mp4',
      ext: 'mp4',
      contentType: 'video/mp4',
      sizeBytes: 100,
      uploadedBy: 'alice',
    });
    expect(w.events).toContain(`onMediaReady id(${A}@room-2)`);
    expect(report.bytesByClassroom).toEqual({ 'room-1': 300, 'room-2': 100 });
  });

  it('rewrites every form, background values included, to that classroom’s media:// id', async () => {
    const w = world();
    const report = await executeMigration(planFor(w.repo), fakeDeps(w));
    expect(JSON.parse(w.repo.get('room-1:slides/d1/deck.json')!.text)).toEqual({
      attrs: { 'data-background-video': `media://id(${A}@room-1)` },
      v: `media://id(${B}@room-1)`,
    });
    expect(w.repo.get('room-1:slides/d1/index.html')!.text).toBe(
      `<section data-background-video="media://id(${A}@room-1)"><video src="media://id(${B}@room-1)"></video>`
    );
    expect(JSON.parse(w.repo.get('room-2:slides/d2/deck.json')!.text)).toEqual({
      src: `media://id(${A}@room-2)`,
    });
    expect(report.decks.map(d => [d.slideId, d.outcome, d.replaced])).toEqual([
      ['d1', 'rewritten', 4],
      ['d2', 'rewritten', 1],
    ]);
  });

  it('HEADs every new copy through the delivery origin before any deck is committed', async () => {
    const w = world();
    await executeMigration(planFor(w.repo), fakeDeps(w));
    const lastHead = w.events.map(e => e.startsWith('HEAD')).lastIndexOf(true);
    const firstCommit = w.events.findIndex(e => e.startsWith('commit'));
    expect(lastHead).toBeGreaterThan(-1);
    expect(firstCommit).toBeGreaterThan(lastHead);
    // And each copy was READY before its HEAD.
    expect(w.events.indexOf(`ready id(${A}@room-1)`)).toBeLessThan(
      w.events.indexOf(
        `HEAD https://content.test/c/room-1/media/${encodeURIComponent(`id(${A}@room-1)`)}`
      )
    );
  });

  it('leaves the Cloudinary URL when the delivery check fails', async () => {
    const w = world();
    w.headStatus = 404;
    const report = await executeMigration(planFor(w.repo), fakeDeps(w));
    expect(report.counts.failed).toBe(3);
    expect(w.events.some(e => e.startsWith('commit'))).toBe(false);
    expect(w.repo.get('room-2:slides/d2/deck.json')!.text).toContain('res.cloudinary.com');
    expect(report.decks.every(d => d.outcome === 'skipped')).toBe(true);
  });

  it('re-reads and re-applies after a sha conflict, bounded', async () => {
    const w = world();
    w.conflicts = 1;
    const report = await executeMigration(planFor(w.repo), fakeDeps(w));
    expect(report.decks[0]).toMatchObject({ slideId: 'd1', outcome: 'rewritten', attempts: 2 });
    expect(w.repo.get('room-1:slides/d1/deck.json')!.text).not.toContain('cloudinary');

    const w2 = world();
    w2.conflicts = 99;
    const stuck = await executeMigration(planFor(w2.repo), fakeDeps(w2));
    expect(stuck.decks[0]).toMatchObject({ outcome: 'failed', attempts: COMMIT_TRIES });
  });

  it('is idempotent: a second run transfers nothing and commits nothing', async () => {
    const w = world();
    const plan = planFor(w.repo);
    await executeMigration(plan, fakeDeps(w));
    w.events.length = 0;

    const again = await executeMigration(plan, fakeDeps(w));
    expect(again.items.every(i => i.outcome === 'reused')).toBe(true);
    expect(again.decks.every(d => d.outcome === 'unchanged')).toBe(true);
    expect(w.events.filter(e => /^(download|put|copy|reserve|commit)/.test(e))).toEqual([]);
    expect(again.bytesByClassroom).toEqual({ 'room-1': 0, 'room-2': 0 });

    // A plan built from the rewritten repo has nothing left to do.
    expect(planFor(w.repo).work).toEqual([]);
  });

  it('replaces an abandoned reservation and never recreates a deleted copy', async () => {
    const w = world();
    w.rows.set(`id(${A}@room-1)`, {
      id: `id(${A}@room-1)`,
      classroom_id: 'room-1',
      status: 'UPLOADING',
    });
    w.rows.set(`id(${B}@room-1)`, {
      id: `id(${B}@room-1)`,
      classroom_id: 'room-1',
      status: 'DELETED',
    });
    const report = await executeMigration(planFor(w.repo), fakeDeps(w));
    expect(w.events[0]).toBe(`release id(${A}@room-1)`);
    expect(report.items.find(i => i.publicId === B)).toMatchObject({ outcome: 'skipped' });
    // B stays on Cloudinary in room-1's deck; A moved.
    const html = w.repo.get('room-1:slides/d1/index.html')!.text;
    expect(html).toContain(`media://id(${A}@room-1)`);
    expect(html).toContain(url(B));
  });

  it('resolves against the plan\u2019s known set, not only its assets', async () => {
    const w = world();
    const plan = planFor(w.repo);
    // B leaves the asset list (say, only a still points at it) but stays known:
    // execute must still resolve B's URLs to B — and, with no copy, leave them.
    const trimmed = { ...plan, assets: plan.assets.filter(a => a.publicId !== B) };
    expect(trimmed.knownPublicIds).toContain(B);
    await executeMigration(trimmed, fakeDeps(w));
    expect(w.repo.get('room-1:slides/d1/index.html')!.text).toContain(url(B));
  });

  it('skips a classroom that cannot serve media, leaving its decks alone', async () => {
    const w = world();
    w.canServe.delete('room-2');
    const report = await executeMigration(planFor(w.repo), fakeDeps(w));
    expect(report.items.find(i => i.classroomId === 'room-2')).toMatchObject({
      outcome: 'skipped',
    });
    expect(report.decks.find(d => d.slideId === 'd2')).toMatchObject({ outcome: 'skipped' });
    expect(w.repo.get('room-2:slides/d2/deck.json')!.sha).toBe('j2');
  });

  it('cleans up the object and the reservation when the stored size is wrong', async () => {
    const w = world();
    const deps = fakeDeps(w);
    deps.putObject = async key => {
      w.objects.set(key, 1);
    };
    const report = await executeMigration(planFor(w.repo), deps);
    expect(report.items[0]).toMatchObject({ outcome: 'failed', detail: 'stored 1 of 100 bytes' });
    expect(w.rows.has(`id(${A}@room-1)`)).toBe(false);
    expect(w.objects.has(`m/room-1/id(${A}@room-1)/orig.mp4`)).toBe(false);
  });
});
