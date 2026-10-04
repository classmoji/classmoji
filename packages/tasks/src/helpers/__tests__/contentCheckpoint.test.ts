/**
 * content-checkpoint: guards, one-commit push, row bookkeeping. Prisma is an
 * in-memory stub that interprets the exact `where` clauses the run uses; git
 * is a real local bare repository over file://; pages render through the real
 * BlockNote server editor and prepare through the real `preparePageContent`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { FRAGMENT, SCHEMA_VERSION, serializePageContent } from '@classmoji/page-schema'; // eslint-disable-line import/no-unresolved
// eslint-disable-next-line import/no-unresolved
import { blocksToYDoc, pageContentToYDoc, yDocToPageContent } from '@classmoji/page-schema/server';
import { ClassmojiService } from '@classmoji/services';
import {
  CONTENT_CHECKPOINT_QUEUE,
  CONTENT_CHECKPOINT_TASK,
  DECK_SCHEMA_VERSION,
  deckToYDoc,
  yDocToDeck,
} from '@classmoji/collab'; // eslint-disable-line import/no-unresolved
import {
  generateDeckHtml,
  prepareDeckForSave,
  type DeckJson,
  type SlideContentTarget,
} from '@classmoji/services/slides'; // eslint-disable-line import/no-unresolved

import { checkPageRender, fragmentBlockIds, shortColumnLists } from '../checkpointGuards.ts';
import {
  checkpointMessage,
  checkpointSubject,
  runContentCheckpoint,
  type CheckpointDeps,
  type CheckpointRow,
  type DeckLike,
  type DeckRenderer,
  type PageRenderer,
} from '../contentCheckpointCore.ts';
import { GitCommandError, commitFilesToRemote } from '../gitCheckpoint.ts';
import { CHECKPOINT_QUEUE_NAME, CHECKPOINT_TASK_ID } from '../../workflows/contentCheckpoint.ts';

// ─── fixtures ────────────────────────────────────────────────────────────────

const para = (id: string, text: string) => ({
  id,
  type: 'paragraph',
  content: [{ type: 'text', text, styles: {} }],
});

const columns = (id: string, n: number) => ({
  id,
  type: 'columnList',
  children: Array.from({ length: n }, (_, i) => ({
    id: `${id}-c${i}`,
    type: 'column',
    props: { width: 1 },
    children: [para(`${id}-c${i}-p`, `col ${i}`)],
  })),
});

const stateOf = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const sh = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

// ─── guards ──────────────────────────────────────────────────────────────────

describe('checkPageRender', () => {
  it('passes a faithful render, columns included', () => {
    const doc = blocksToYDoc([para('p1', 'a'), columns('cl', 2)]);
    const { blocks } = yDocToPageContent(doc);
    expect(fragmentBlockIds(doc, FRAGMENT)).toEqual([
      'p1',
      'cl',
      'cl-c0',
      'cl-c0-p',
      'cl-c1',
      'cl-c1-p',
    ]);
    expect(checkPageRender(doc, FRAGMENT, blocks)).toMatchObject({ ok: true, droppedIds: [] });
  });

  it('refuses a render that lost a block the document still holds', () => {
    const doc = blocksToYDoc([para('p1', 'a')]);
    // A block the schema does not know: BlockNote's conversion deletes it.
    const group = doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', 'mystery');
    container.insert(0, [new Y.XmlElement('mysteryBlock')]);
    group.insert(1, [container]);

    const { blocks } = yDocToPageContent(doc);
    const result = checkPageRender(doc, FRAGMENT, blocks);
    expect(result.ok).toBe(false);
    expect(result.droppedIds).toEqual(['mystery']);
    expect(result.reason).toMatch(/dropped 1 block/);
  });

  it('does NOT refuse a block deleted on purpose (it is gone from the document too)', () => {
    const doc = blocksToYDoc([para('p1', 'a'), para('p2', 'b')]);
    const group = doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
    group.delete(1, 1);
    const { blocks } = yDocToPageContent(doc);
    expect(checkPageRender(doc, FRAGMENT, blocks).ok).toBe(true);
  });

  it('refuses a column layout with fewer than two columns', () => {
    const blocks = [para('p1', 'a'), columns('one', 1), columns('ok', 3)];
    expect(shortColumnLists(blocks)).toEqual(['one']);
    const doc = blocksToYDoc([para('p1', 'a')]);
    const result = checkPageRender(doc, FRAGMENT, blocks);
    expect(result.ok).toBe(false);
    expect(result.shortColumnLists).toEqual(['one']);
  });
});

describe('commit message', () => {
  it('lists titles, then trailers', () => {
    expect(checkpointSubject(['Intro'])).toBe('Update Intro (live editing)');
    expect(checkpointSubject(['A', 'B'])).toBe('Update A and B (live editing)');
    expect(checkpointSubject(['A', 'B', 'C', 'D', 'E'])).toBe(
      'Update A, B, C and 2 more (live editing)'
    );
    expect(
      checkpointMessage({
        titles: ['Intro'],
        runId: 'run_1',
        body: 'Before the midterm',
        coAuthors: [{ name: 'Ada\n<x>', email: '1+ada@users.noreply.github.com' }],
      })
    ).toBe(
      'Update Intro (live editing)\n\nBefore the midterm\n\nClassmoji-Collab: run_1\n' +
        'Co-authored-by: Ada x <1+ada@users.noreply.github.com>\n'
    );
  });
});

// ─── the run ─────────────────────────────────────────────────────────────────

type Row = CheckpointRow & {
  classroom_id: string;
  pushed_commit: string | null;
  dirty_since: Date | null;
};

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-repo',
  git_namespace: null,
  // No content_key_version: the record tail is stubbed anyway.
  git_organization: { provider: 'GITHUB', login: 'org' },
};

function makePrisma(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const actual = row[k as keyof Row];
      if (v && typeof v === 'object' && 'lt' in (v as object)) {
        return (actual as number) < (v as { lt: number }).lt;
      }
      return actual === v;
    });
  const meta = (r: Row) => ({
    kind: r.kind,
    doc_id: r.doc_id,
    epoch: r.epoch,
    version: r.version,
    pushed_version: r.pushed_version,
    schema_version: r.schema_version,
    source_sha: r.source_sha,
  });
  return {
    rows,
    // The dirty-row filter, as the SQL states it.
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, classroomId: string) =>
      rows
        .filter(
          r =>
            r.classroom_id === classroomId && r.version > r.pushed_version && r.state.byteLength > 0
        )
        .sort((a, b) => (a.kind + a.doc_id).localeCompare(b.kind + b.doc_id))
        .map(meta)
    ),
    classroom: { findUnique: vi.fn(async () => CLASSROOM) },
    collabDoc: {
      findUnique: vi.fn(
        async ({ where }: { where: { kind_doc_id: { kind: string; doc_id: string } } }) => {
          const r = rows.find(
            x => x.kind === where.kind_doc_id.kind && x.doc_id === where.kind_doc_id.doc_id
          );
          return r ? { ...meta(r), state: r.state } : null;
        }
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
          let count = 0;
          for (const r of rows) {
            if (!matches(r, where)) continue;
            Object.assign(r, data);
            count++;
          }
          return { count };
        }
      ),
    },
    page: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [
          { id: 'page-a', title: 'Intro', content_path: 'pages/intro' },
          { id: 'page-b', title: 'Lab 1', content_path: 'pages/lab-1' },
          { id: 'page-c', title: 'Clean', content_path: 'pages/clean' },
          // Same folder as page-a: a path conflict.
          { id: 'page-dup', title: 'Intro copy', content_path: 'pages/intro' },
          { id: 'page-evil', title: 'Evil', content_path: '../outside' },
        ].filter(p => where.id.in.includes(p.id))
      ),
    },
    slide: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        [{ id: 'deck-a', title: 'Week 1', content_path: 'slides/week-1', kind: 'DECK' }].filter(s =>
          where.id.in.includes(s.id)
        )
      ),
    },
    account: {
      findMany: vi.fn(async () => [{ user_id: 'u-ada', account_id: '101', username: 'ada' }]),
    },
  };
}

function row(kind: string, docId: string, doc: Y.Doc, version = 1, extra: Partial<Row> = {}): Row {
  return {
    kind,
    doc_id: docId,
    classroom_id: 'class-1',
    epoch: 1,
    version,
    pushed_version: 0,
    schema_version: kind === 'page' ? SCHEMA_VERSION : DECK_SCHEMA_VERSION,
    state: stateOf(doc),
    source_sha: null,
    pushed_commit: null,
    dirty_since: new Date('2026-10-03T12:00:00Z'),
    ...extra,
  };
}

const realPageRenderer: PageRenderer = {
  fragment: FRAGMENT,
  schemaVersion: SCHEMA_VERSION,
  render: doc => {
    const c = yDocToPageContent(doc);
    return { blocks: c.blocks, coverImage: c.coverImage ?? null };
  },
};

const deckRenderer = (render: (doc: Y.Doc) => DeckLike): DeckRenderer => ({
  schemaVersion: DECK_SCHEMA_VERSION,
  render,
});

let root: string;
let remote: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'checkpoint-run-'));
  remote = path.join(root, 'remote.git');
  sh(['init', '--bare', '-b', 'main', remote]);
  sh(['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  const work = path.join(root, 'work');
  sh(['clone', `file://${remote}`, work]);
  sh(['checkout', '-b', 'main'], work);
  mkdirSync(path.join(work, 'pages', 'intro'), { recursive: true });
  writeFileSync(path.join(work, 'pages', 'intro', 'content.json'), '{"blocks":[]}');
  writeFileSync(path.join(work, 'README.md'), 'x\n');
  sh(['add', '-A'], work);
  sh(['commit', '-m', 'seed'], work);
  sh(['push', 'origin', 'main'], work);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const remoteFile = (p: string) => sh(['--git-dir', remote, 'show', `main:${p}`]);
const remoteLog = () => sh(['--git-dir', remote, 'log', '--format=%s', 'main']).split('\n');

function makeDeps(prisma: ReturnType<typeof makePrisma>, over: Partial<CheckpointDeps> = {}) {
  const recordPageFile = vi.fn(async () => {});
  const recordDeckCommit = vi.fn(async () => {});
  const ensureContentRepo = vi.fn(async () => {});
  const notifyOutsideEdit = vi.fn(async () => {});
  const deps: CheckpointDeps = {
    prisma: prisma as unknown as CheckpointDeps['prisma'],
    loadPageRenderer: async () => realPageRenderer,
    loadDeckRenderer: async () => null,
    // The REAL prepare step a save runs.
    preparePageContent: (page, blocks, options) =>
      ClassmojiService.pageContent.preparePageContent(page as never, blocks, options),
    recordPageFile,
    resolveDeckThemeUrls: async () => undefined,
    prepareDeckForSave: async (slide, deck) => ({
      deckPath: `${slide.content_path}/deck.json`,
      htmlPath: `${slide.content_path}/index.html`,
      deckJson: JSON.stringify(deck, null, 2) + '\n',
      html: `<html>${deck.slides.length}</html>`,
    }),
    recordDeckCommit,
    remote: async () => ({ url: `file://${remote}` }),
    ensureContentRepo,
    commitFiles: input => commitFilesToRemote({ ...input, tmpRoot: root }),
    notifyOutsideEdit,
    author: { name: 'Classmoji Bot', email: 'hello@classmoji.com' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
  return { deps, recordPageFile, recordDeckCommit, ensureContentRepo, notifyOutsideEdit };
}

describe('runContentCheckpoint', () => {
  it('pushes every dirty page in ONE commit and marks the rows clean', async () => {
    const docA = pageContentToYDoc({
      blocks: [para('a1', 'Hello'), columns('cols', 2)],
      coverImage: { url: 'pages/intro/assets/c.png', position: 30 },
    });
    const docB = blocksToYDoc([para('b1', 'Lab text')]);
    const docC = blocksToYDoc([para('c1', 'clean')]);
    const prisma = makePrisma([
      row('page', 'page-a', docA, 3),
      row('page', 'page-b', docB, 1),
      // Clean, and a reseed marker: neither is touched.
      row('page', 'page-c', docC, 2, { pushed_version: 2, dirty_since: null }),
      row('page', 'page-gone', docC, 5, { state: new Uint8Array() }),
    ]);
    const { deps, recordPageFile } = makeDeps(prisma);

    const report = await runContentCheckpoint(
      {
        classroomId: 'class-1',
        reason: 'store',
        editors: [
          { kind: 'page', docId: 'page-a', editors: [{ userId: 'u-ada', name: 'Ada L' }] },
          // No GitHub account: no trailer, no invented address.
          { kind: 'page', docId: 'page-b', editors: [{ userId: 'u-nogh', name: 'Nobody' }] },
          // Not in this commit: never credited.
          { kind: 'page', docId: 'page-c', editors: [{ userId: 'u-ada', name: 'Ada L' }] },
        ],
      },
      { runId: 'run_abc' },
      deps
    );

    expect(report.pushed).toBe(true);
    expect(report.attempts).toBe(1);
    expect(report.lazyFetches).toBe(0);
    expect(remoteLog()).toEqual(['Update Intro and Lab 1 (live editing)', 'seed']);
    const body = sh(['--git-dir', remote, 'log', '-1', '--format=%B', 'main']);
    expect(body).toContain('Classmoji-Collab: run_abc');
    expect(body).toContain('Co-authored-by: Ada L <101+ada@users.noreply.github.com>');
    expect(body).not.toContain('Nobody');
    expect(sh(['--git-dir', remote, 'log', '-1', '--format=%an <%ae>', 'main'])).toBe(
      'Classmoji Bot <hello@classmoji.com>'
    );

    // Byte-identical to what savePageContent writes for the same document.
    const rendered = yDocToPageContent(docA);
    expect(remoteFile('pages/intro/content.json')).toBe(serializePageContent(rendered));
    expect(JSON.parse(remoteFile('pages/intro/content.json')).coverImage).toEqual({
      url: 'pages/intro/assets/c.png',
      position: 30,
    });
    expect(JSON.parse(remoteFile('pages/lab-1/content.json')).blocks[0].id).toBe('b1');
    expect(remoteFile('README.md')).toBe('x');

    const [a, b, c, gone] = prisma.rows;
    const head = sh(['--git-dir', remote, 'rev-parse', 'main']);
    expect(a).toMatchObject({ pushed_version: 3, pushed_commit: head, dirty_since: null });
    expect(a.source_sha).toBe(
      sh(['--git-dir', remote, 'rev-parse', 'main:pages/intro/content.json'])
    );
    expect(b).toMatchObject({ pushed_version: 1, pushed_commit: head, dirty_since: null });
    expect(c).toMatchObject({ pushed_version: 2, pushed_commit: null });
    expect(gone).toMatchObject({ pushed_version: 0, pushed_commit: null });

    // Record ran after the push, with the committed blob sha, awaiting its tail.
    expect(recordPageFile).toHaveBeenCalledTimes(2);
    expect(recordPageFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'page-a', classroom: CLASSROOM }),
      'pages/intro/content.json',
      a.source_sha,
      remoteFile('pages/intro/content.json'),
      { awaitTail: true }
    );
    expect(report.docs.map(d => [d.docId, d.status, d.clean])).toEqual([
      ['page-a', 'pushed', true],
      ['page-b', 'pushed', true],
    ]);
  });

  it('a version stored mid-run is credited as pushed but the row stays dirty', async () => {
    const prisma = makePrisma([row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 4)]);
    const { deps } = makeDeps(prisma, {
      commitFiles: async input => {
        const result = await commitFilesToRemote({ ...input, tmpRoot: root });
        prisma.rows[0].version = 5; // someone typed while we pushed
        return result;
      },
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(prisma.rows[0]).toMatchObject({ version: 5, pushed_version: 4 });
    expect(prisma.rows[0].dirty_since).not.toBeNull();
    expect(prisma.rows[0].pushed_commit).toBe(report.commit);
    expect(report.docs[0]).toMatchObject({ status: 'pushed', clean: false });
  });

  it('never marks a row that was reseeded (epoch bumped) during the run', async () => {
    const prisma = makePrisma([row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 4)]);
    const { deps } = makeDeps(prisma, {
      commitFiles: async input => {
        const result = await commitFilesToRemote({ ...input, tmpRoot: root });
        Object.assign(prisma.rows[0], { epoch: 2, version: 0, pushed_version: 0 });
        return result;
      },
    });
    await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(prisma.rows[0]).toMatchObject({ epoch: 2, pushed_version: 0, pushed_commit: null });
  });

  it('refuses a broken page, leaves it dirty, and still pushes the others', async () => {
    const bad = blocksToYDoc([para('x1', 'x')]);
    const group = bad.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
    const container = new Y.XmlElement('blockContainer');
    container.setAttribute('id', 'mystery');
    container.insert(0, [new Y.XmlElement('mysteryBlock')]);
    group.insert(1, [container]);

    const prisma = makePrisma([
      row('page', 'page-a', bad, 2),
      row('page', 'page-b', blocksToYDoc([para('b1', 'fine')]), 1),
    ]);
    const { deps, recordPageFile } = makeDeps(prisma);
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);

    expect(report.docs.find(d => d.docId === 'page-a')).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/mystery/),
    });
    expect(prisma.rows[0]).toMatchObject({ pushed_version: 0, pushed_commit: null });
    expect(prisma.rows[0].dirty_since).not.toBeNull();
    expect(remoteFile('pages/intro/content.json')).toBe('{"blocks":[]}');
    expect(remoteLog()[0]).toBe('Update Lab 1 (live editing)');
    expect(recordPageFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a single-column layout (no repair in the worker)', async () => {
    const prisma = makePrisma([row('page', 'page-a', blocksToYDoc([para('a', 'a')]), 1)]);
    const { deps } = makeDeps(prisma, {
      loadPageRenderer: async () => ({
        ...realPageRenderer,
        render: () => ({ blocks: [para('a', 'a'), columns('one', 1)], coverImage: null }),
      }),
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs[0]).toMatchObject({ status: 'refused' });
    expect(report.commit).toBeNull();
    expect(remoteLog()).toEqual(['seed']);
  });

  it('an unchanged render makes no commit but still marks the row pushed', async () => {
    const doc = blocksToYDoc([para('a1', 'same')]);
    const prisma = makePrisma([row('page', 'page-a', doc, 1)]);
    const { deps, recordPageFile } = makeDeps(prisma);
    await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r1' }, deps);
    const head = sh(['--git-dir', remote, 'rev-parse', 'main']);

    // An undo back to the pushed state: version moves, bytes do not.
    Object.assign(prisma.rows[0], { version: 2, dirty_since: new Date() });
    recordPageFile.mockClear();
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r2' }, deps);

    expect(report).toMatchObject({ pushed: false, attempts: 0, commit: head });
    expect(sh(['--git-dir', remote, 'rev-parse', 'main'])).toBe(head);
    expect(prisma.rows[0]).toMatchObject({ pushed_version: 2, dirty_since: null });
    expect(report.docs[0].status).toBe('unchanged');
    // Recorded again anyway (idempotent): covers a crash between push and record.
    expect(recordPageFile).toHaveBeenCalledTimes(1);
  });

  it('creates a missing content repo through ensureContentRepo, then pushes', async () => {
    const prisma = makePrisma([row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 1)]);
    let calls = 0;
    const { deps, ensureContentRepo } = makeDeps(prisma, {
      commitFiles: async input => {
        if (calls++ === 0) {
          throw new GitCommandError(
            ['clone'],
            128,
            "remote: Repository not found.\nfatal: repository 'x' not found"
          );
        }
        return commitFilesToRemote({ ...input, tmpRoot: root });
      },
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(ensureContentRepo).toHaveBeenCalledWith('class-1');
    expect(report.pushed).toBe(true);
  });

  it('a push failure throws (the task retries) and leaves every row dirty', async () => {
    const prisma = makePrisma([row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 1)]);
    const { deps, recordPageFile } = makeDeps(prisma, {
      commitFiles: async () => {
        throw new GitCommandError(['push'], 1, 'remote: Permission denied');
      },
    });
    await expect(
      runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps)
    ).rejects.toThrow(/Permission denied/);
    expect(prisma.rows[0]).toMatchObject({ pushed_version: 0, pushed_commit: null });
    expect(recordPageFile).not.toHaveBeenCalled();
  });

  it('leaves decks dirty while the converter is unavailable, pages unaffected', async () => {
    const prisma = makePrisma([
      row('deck', 'deck-a', new Y.Doc(), 1),
      row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 1),
    ]);
    // A non-empty state for the deck row.
    const deckDoc = new Y.Doc();
    deckDoc.getMap('meta').set('theme', 'white');
    prisma.rows[0].state = stateOf(deckDoc);
    const { deps } = makeDeps(prisma);
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs.find(d => d.kind === 'deck')).toMatchObject({
      status: 'skipped',
      reason: 'deck converter unavailable',
    });
    expect(prisma.rows[0].pushed_version).toBe(0);
    expect(prisma.rows[1].pushed_version).toBe(1);
  });

  it('commits deck.json AND index.html for a deck, and records both', async () => {
    const deckDoc = new Y.Doc();
    const slides = deckDoc.getMap('slides');
    const s1 = new Y.Map();
    slides.set('s1', s1);
    const prisma = makePrisma([row('deck', 'deck-a', deckDoc, 7)]);
    const deck: DeckLike = {
      version: 1,
      theme: 'white',
      slides: [{ id: 's1', html: '<h1>Hi</h1>' }],
    };
    const { deps, recordDeckCommit } = makeDeps(prisma, {
      loadDeckRenderer: async () => deckRenderer(() => deck),
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);

    expect(report.docs[0]).toMatchObject({
      status: 'pushed',
      paths: ['slides/week-1/deck.json', 'slides/week-1/index.html'],
    });
    expect(remoteLog()[0]).toBe('Update Week 1 (live editing)');
    expect(JSON.parse(remoteFile('slides/week-1/deck.json'))).toEqual(deck);
    expect(remoteFile('slides/week-1/index.html')).toBe('<html>1</html>');
    const deckSha = sh(['--git-dir', remote, 'rev-parse', 'main:slides/week-1/deck.json']);
    expect(prisma.rows[0]).toMatchObject({
      pushed_version: 7,
      source_sha: deckSha,
      dirty_since: null,
    });
    expect(recordDeckCommit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deck-a', kind: 'DECK' }),
      [
        { path: 'slides/week-1/deck.json', sha: deckSha },
        {
          path: 'slides/week-1/index.html',
          sha: sh(['--git-dir', remote, 'rev-parse', 'main:slides/week-1/index.html']),
        },
      ],
      expect.any(Array),
      { awaitTail: true }
    );
  });

  it('refuses a deck render that lost a slide the document holds', async () => {
    const deckDoc = new Y.Doc();
    deckDoc.getMap('slides').set('s1', new Y.Map());
    deckDoc.getMap('slides').set('s2', new Y.Map());
    const prisma = makePrisma([row('deck', 'deck-a', deckDoc, 1)]);
    const { deps } = makeDeps(prisma, {
      loadDeckRenderer: async () =>
        deckRenderer(() => ({ version: 1, slides: [{ id: 's1', html: '' }] })),
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/s2/),
    });
    expect(remoteLog()).toEqual(['seed']);
  });

  it('does nothing when no row is dirty', async () => {
    const prisma = makePrisma([
      row('page', 'page-a', blocksToYDoc([para('a', 'a')]), 1, { pushed_version: 1 }),
    ]);
    const { deps } = makeDeps(prisma, { remote: vi.fn() });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report).toMatchObject({ commit: null, pushed: false, docs: [] });
    expect(deps.remote).not.toHaveBeenCalled();
  });
});

describe('runContentCheckpoint with the real deck converter', () => {
  it('commits exactly the deck.json and index.html saveDeck would write', async () => {
    const deck: DeckJson = {
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      config: { center: false },
      slides: [
        {
          id: 'aaaa1111',
          html: '<h1>Title</h1>',
          notes: 'Say hi',
          attrs: { 'data-transition': 'fade' },
        },
        {
          id: 'bbbb2222',
          children: [
            { id: 'cccc3333', html: '<p>Down 1</p>' },
            { id: 'dddd4444', html: '<p>Down 2</p>', hidden: true },
          ],
        },
        { id: 'eeee5555', html: '<pre><code>x = 1</code></pre>' },
      ],
    };
    const doc = deckToYDoc(deck);
    const prisma = makePrisma([row('deck', 'deck-a', doc, 2)]);
    const { deps } = makeDeps(prisma, {
      loadDeckRenderer: async () => deckRenderer(yDocToDeck as unknown as (d: Y.Doc) => DeckLike),
      prepareDeckForSave: (slide, d, options) =>
        prepareDeckForSave(
          slide as unknown as SlideContentTarget,
          d as unknown as DeckJson,
          options as never
        ),
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs[0]).toMatchObject({ status: 'pushed', clean: true });

    // What saveDeck commits for this deck: two-space JSON + newline, and the
    // generated index.html with notes.
    expect(remoteFile('slides/week-1/deck.json') + '\n').toBe(JSON.stringify(deck, null, 2) + '\n');
    expect(remoteFile('slides/week-1/index.html')).toBe(
      generateDeckHtml(deck, { title: 'Week 1', includeNotes: true }).trimEnd()
    );
  });
});

describe('runContentCheckpoint review fixes', () => {
  const blobAt = (p: string) => sh(['--git-dir', remote, 'rev-parse', `main:${p}`]);

  it('task ids match the @classmoji/collab contract', () => {
    expect(CHECKPOINT_TASK_ID).toBe(CONTENT_CHECKPOINT_TASK);
    expect(CHECKPOINT_QUEUE_NAME).toBe(CONTENT_CHECKPOINT_QUEUE);
  });

  it('refuses rows written with another schema version, without loading their state', async () => {
    const prisma = makePrisma([
      row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 1, {
        schema_version: SCHEMA_VERSION + 1,
      }),
      row('page', 'page-b', blocksToYDoc([para('b1', 'fine')]), 1),
    ]);
    const { deps } = makeDeps(prisma);
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs.find(d => d.docId === 'page-a')).toMatchObject({
      status: 'refused',
      code: 'schema-mismatch',
    });
    expect(prisma.collabDoc.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.rows[0]).toMatchObject({ pushed_version: 0 });
    expect(prisma.rows[1]).toMatchObject({ pushed_version: 1 });
  });

  it('refuses a deck row from another deck schema', async () => {
    const d = new Y.Doc();
    d.getMap('slides').set('s1', new Y.Map());
    const prisma = makePrisma([row('deck', 'deck-a', d, 1, { schema_version: 99 })]);
    const { deps } = makeDeps(prisma, {
      loadDeckRenderer: async () => deckRenderer(() => ({ version: 1, slides: [{ id: 's1' }] })),
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs[0]).toMatchObject({ status: 'refused', code: 'schema-mismatch' });
  });

  it('refuses a page that renders to zero blocks and a deck with zero slides', async () => {
    const d = new Y.Doc();
    d.getMap('meta').set('theme', 'white');
    const prisma = makePrisma([
      row('page', 'page-a', blocksToYDoc([para('a1', 'x')]), 1),
      row('deck', 'deck-a', d, 1),
    ]);
    const { deps } = makeDeps(prisma, {
      loadPageRenderer: async () => ({ ...realPageRenderer, render: () => ({ blocks: [] }) }),
      loadDeckRenderer: async () => deckRenderer(() => ({ version: 1, slides: [] })),
    });
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs.map(x => [x.docId, x.code])).toEqual([
      ['deck-a', 'empty-render'],
      ['page-a', 'empty-render'],
    ]);
    expect(remoteLog()).toEqual(['seed']);
  });

  it('refuses docs sharing a path or with an unsafe path, commits the rest', async () => {
    const prisma = makePrisma([
      row('page', 'page-a', blocksToYDoc([para('a1', 'a')]), 1),
      row('page', 'page-b', blocksToYDoc([para('b1', 'b')]), 1),
      row('page', 'page-dup', blocksToYDoc([para('d1', 'd')]), 1),
      row('page', 'page-evil', blocksToYDoc([para('e1', 'e')]), 1),
    ]);
    const { deps } = makeDeps(prisma);
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    const byId = Object.fromEntries(report.docs.map(d => [d.docId, d]));
    expect(byId['page-a']).toMatchObject({ status: 'refused', code: 'path-conflict' });
    expect(byId['page-dup']).toMatchObject({ status: 'refused', code: 'path-conflict' });
    expect(byId['page-evil']).toMatchObject({ status: 'refused', code: 'unsafe-path' });
    expect(byId['page-b']).toMatchObject({ status: 'pushed' });
    expect(remoteFile('pages/intro/content.json')).toBe('{"blocks":[]}');
    expect(remoteLog()[0]).toBe('Update Lab 1 (live editing)');
  });

  it('backstop: a file changed outside since source_sha is left alone and collab is told', async () => {
    const prisma = makePrisma([
      // The live doc descends from some other blob than what main holds now.
      row('page', 'page-a', blocksToYDoc([para('a1', 'ours')]), 3, { source_sha: 'f'.repeat(40) }),
      row('page', 'page-b', blocksToYDoc([para('b1', 'b')]), 1),
    ]);
    const { deps, notifyOutsideEdit, recordPageFile } = makeDeps(prisma);
    const head = sh(['--git-dir', remote, 'rev-parse', 'main']);
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);

    expect(report.docs.find(d => d.docId === 'page-a')).toMatchObject({
      status: 'refused',
      code: 'outside-edit-pending',
    });
    expect(notifyOutsideEdit).toHaveBeenCalledWith({
      classroomId: 'class-1',
      kind: 'page',
      docId: 'page-a',
      sha: head,
    });
    expect(remoteFile('pages/intro/content.json')).toBe('{"blocks":[]}');
    expect(prisma.rows[0]).toMatchObject({ pushed_version: 0, source_sha: 'f'.repeat(40) });
    expect(prisma.rows[1]).toMatchObject({ pushed_version: 1 });
    expect(remoteLog()[0]).toBe('Update Lab 1 (live editing)');
    expect(recordPageFile).toHaveBeenCalledTimes(1);
  });

  it('backstop: a matching source_sha writes as usual', async () => {
    const prisma = makePrisma([
      row('page', 'page-a', blocksToYDoc([para('a1', 'ours')]), 2, {
        source_sha: blobAt('pages/intro/content.json'),
      }),
    ]);
    const { deps, notifyOutsideEdit } = makeDeps(prisma);
    const report = await runContentCheckpoint({ classroomId: 'class-1' }, { runId: 'r' }, deps);
    expect(report.docs[0]).toMatchObject({ status: 'pushed', clean: true });
    expect(notifyOutsideEdit).not.toHaveBeenCalled();
    expect(prisma.rows[0].source_sha).toBe(blobAt('pages/intro/content.json'));
  });

  it('keeps a Save-version message visible when nothing was left to push', async () => {
    const prisma = makePrisma([
      row('page', 'page-a', blocksToYDoc([para('a', 'a')]), 1, { pushed_version: 1 }),
    ]);
    const { deps } = makeDeps(prisma);
    const report = await runContentCheckpoint(
      { classroomId: 'class-1', reason: 'save-version', message: 'Before the midterm' },
      { runId: 'r' },
      deps
    );
    expect(report.unusedMessage).toBe('Before the midterm');
  });

  it('subject lines never carry a newline from a title', () => {
    expect(checkpointSubject(['Line one\nLine two', 'A <b>'])).toBe(
      'Update Line one Line two and A b (live editing)'
    );
  });
});
