/**
 * htmlBlockFiles.service: writing, reading, deleting and listing the files
 * behind html blocks. Prisma, ContentService, the asset map and the audit
 * log are mocked; the gate runs for real against the mocked rows, so the
 * scoping cases (user A vs B, classroom X vs Y, roles, classroom status) are
 * the service's own decisions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SlideRow {
  id: string;
  kind: string;
  title: string;
  classroom_id: string;
  content_path: string;
  created_by: string;
  allow_team_edit: boolean;
  classroom: {
    id: string;
    status: string;
    content_repo: string | null;
    git_organization: { provider: string; login: string } | null;
  };
}

const db = vi.hoisted(() => ({
  slides: new Map<string, unknown>(),
  memberships: [] as Array<{ classroom_id: string; user_id: string; role: string }>,
}));

const content = vi.hoisted(() => ({
  put: vi.fn(),
  getMeta: vi.fn(),
  getBlobContent: vi.fn(),
  delete: vi.fn(),
  listFolder: vi.fn(),
}));

const assets = vi.hoisted(() => ({
  recordContentAsset: vi.fn(),
  recordFolderTreesAfterCommit: vi.fn(),
  removeContentAssets: vi.fn(),
}));

const auditCreate = vi.hoisted(() => vi.fn());

vi.mock('@classmoji/database', () => ({
  default: () => ({
    slide: {
      findUnique: async ({ where }: { where: { id: string } }) => db.slides.get(where.id) ?? null,
    },
    classroomMembership: {
      findMany: async ({ where }: { where: { classroom_id: string; user_id: string } }) =>
        db.memberships
          .filter(m => m.classroom_id === where.classroom_id && m.user_id === where.user_id)
          .map(m => ({ role: m.role })),
    },
  }),
}));

vi.mock('../../content/ContentService.ts', () => ({ ContentService: content }));
vi.mock('../../classmoji/contentAssets.service.ts', () => assets);
vi.mock('../../classmoji/audit.service.ts', () => ({ create: auditCreate }));

const {
  writeHtmlBlockFile,
  readHtmlBlockSource,
  readHtmlBlockSources,
  deleteHtmlBlockFile,
  listRepoFolder,
  HtmlBlockFileError,
} = await import('../htmlBlockFiles.service.ts');

const REV = 'a'.repeat(40);
const NEW_REV = 'b'.repeat(40);
const ORG = { provider: 'GITHUB', login: 'org-x' };

function slide(id: string, classroomId: string, overrides: Partial<SlideRow> = {}): SlideRow {
  return {
    id,
    kind: 'DECK',
    title: `Deck ${id}`,
    classroom_id: classroomId,
    content_path: `slides/${id}`,
    created_by: 'teacher-x',
    allow_team_edit: false,
    classroom: {
      id: classroomId,
      status: 'ACTIVE',
      content_repo: `content-${classroomId}`,
      git_organization: ORG,
    },
    ...overrides,
  };
}

function member(classroomId: string, userId: string, role: string) {
  db.memberships.push({ classroom_id: classroomId, user_id: userId, role });
}

/** The error a call rejected with. */
async function refusal(
  promise: Promise<unknown>
): Promise<InstanceType<typeof HtmlBlockFileError>> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HtmlBlockFileError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  db.slides.clear();
  db.memberships.length = 0;
  db.slides.set('deck-x', slide('deck-x', 'class-x'));
  db.slides.set('deck-y', slide('deck-y', 'class-y'));
  member('class-x', 'teacher-x', 'TEACHER');
  member('class-y', 'teacher-y', 'OWNER');
  content.put.mockResolvedValue({ sha: NEW_REV, commit: 'commit-1', treeSha: 'tree-1' });
  assets.recordFolderTreesAfterCommit.mockResolvedValue(new Map());
});

describe('writeHtmlBlockFile', () => {
  it('creates a new blocks/ file, records its folders and audits the write', async () => {
    const ref = await writeHtmlBlockFile({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      html: '<!doctype html><p>hi</p>',
      blockId: 'b1',
    });
    expect(ref.src).toMatch(/^blocks\/[0-9a-f]{8}\.html$/);
    expect(ref.rev).toBe(NEW_REV);
    expect(content.put).toHaveBeenCalledTimes(1);
    const put = content.put.mock.calls[0][0];
    expect(put).toMatchObject({
      repo: 'content-class-x',
      path: `slides/deck-x/${ref.src}`,
      content: '<!doctype html><p>hi</p>',
      createOnly: true,
    });
    expect(put.expectedSha).toBeUndefined();
    expect(put.content).not.toContain('data-cm-storage-shim');
    expect(assets.recordContentAsset).toHaveBeenCalledWith('class-x', {
      path: `slides/deck-x/${ref.src}`,
      sha: NEW_REV,
      size: 24,
    });
    expect(assets.recordFolderTreesAfterCommit).toHaveBeenCalledWith({
      classroomId: 'class-x',
      commit: 'commit-1',
      rootTreeSha: 'tree-1',
      folders: ['slides/deck-x', 'slides/deck-x/blocks'],
    });
    expect(auditCreate).toHaveBeenCalledWith(
      {
        classroom_id: 'class-x',
        user_id: 'teacher-x',
        role: 'TEACHER',
        resource_type: 'SLIDES',
        resource_id: 'deck-x',
        action: 'UPDATE',
        data: {
          tool: 'slides:html_block.save',
          slide_id: 'deck-x',
          path: `slides/deck-x/${ref.src}`,
          rev: NEW_REV,
          block_id: 'b1',
        },
      },
      { dedupe: false }
    );
  });

  it('overwrites the block file with a compare-and-swap on expectedRev', async () => {
    const ref = await writeHtmlBlockFile({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      html: 'v2',
      src: 'blocks/0a0b0c0d.html',
      expectedRev: REV,
      surface: 'mcp',
    });
    expect(ref).toEqual({ src: 'blocks/0a0b0c0d.html', rev: NEW_REV });
    expect(content.put.mock.calls[0][0]).toMatchObject({
      path: 'slides/deck-x/blocks/0a0b0c0d.html',
      expectedSha: REV,
    });
    expect(content.put.mock.calls[0][0].createOnly).toBeUndefined();
    expect(auditCreate.mock.calls[0][0].data.tool).toBe('mcp:html_block.save');
  });

  it('maps a compare-and-swap conflict to changed (409)', async () => {
    content.put.mockRejectedValueOnce(Object.assign(new Error('modified'), { status: 409 }));
    const error = await refusal(
      writeHtmlBlockFile({
        slideId: 'deck-x',
        actorUserId: 'teacher-x',
        html: 'v2',
        src: 'blocks/0a0b0c0d.html',
        expectedRev: REV,
      })
    );
    expect(error.code).toBe('changed');
    expect(error.status).toBe(409);
    expect(assets.recordContentAsset).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['no expectedRev', { src: 'blocks/0a0b0c0d.html' }],
    ['fork', { src: 'blocks/0a0b0c0d.html', expectedRev: REV, fork: true }],
    ['preview', { src: 'blocks/0a0b0c0d.html', expectedRev: REV, mode: 'preview' as const }],
  ])('writes a new file instead of overwriting: %s', async (_name, extra) => {
    const ref = await writeHtmlBlockFile({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      html: 'x',
      ...extra,
    });
    expect(ref.src).not.toBe('blocks/0a0b0c0d.html');
    expect(content.put.mock.calls[0][0]).toMatchObject({ createOnly: true });
  });

  it('tries another name when a new one is taken', async () => {
    content.put
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { status: 409 }))
      .mockResolvedValueOnce({ sha: NEW_REV, commit: 'c2' });
    const ref = await writeHtmlBlockFile({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      html: 'x',
    });
    expect(content.put).toHaveBeenCalledTimes(2);
    expect(content.put.mock.calls[1][0].path).toBe(`slides/deck-x/${ref.src}`);
    expect(content.put.mock.calls[0][0].path).not.toBe(content.put.mock.calls[1][0].path);
  });

  it('allows 1,000,000 UTF-8 bytes and refuses more', async () => {
    await writeHtmlBlockFile({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      html: 'x'.repeat(1_000_000),
    });
    for (const html of ['x'.repeat(1_000_001), 'é'.repeat(500_001)]) {
      const error = await refusal(
        writeHtmlBlockFile({ slideId: 'deck-x', actorUserId: 'teacher-x', html })
      );
      expect(error.code).toBe('too-large');
      expect(error.status).toBe(413);
    }
    expect(content.put).toHaveBeenCalledTimes(1);
  });

  it.each([
    'games/x.html',
    '../deck-y/blocks/0a0b0c0d.html',
    'blocks/0A0B0C0D.html',
    'blocks/x.html',
  ])('refuses src %j', async src => {
    const error = await refusal(
      writeHtmlBlockFile({
        slideId: 'deck-x',
        actorUserId: 'teacher-x',
        html: 'x',
        src,
        expectedRev: REV,
      })
    );
    expect(error.code).toBe('invalid');
    expect(content.put).not.toHaveBeenCalled();
  });

  it('refuses an expectedRev that is not a blob sha', async () => {
    const error = await refusal(
      writeHtmlBlockFile({
        slideId: 'deck-x',
        actorUserId: 'teacher-x',
        html: 'x',
        src: 'blocks/0a0b0c0d.html',
        expectedRev: 'HEAD',
      })
    );
    expect(error.code).toBe('invalid');
  });
});

describe('the gate', () => {
  const write = (slideId: string, actorUserId: string) =>
    writeHtmlBlockFile({ slideId, actorUserId, html: 'x' });

  it('user A vs B: a teacher of another classroom cannot write', async () => {
    const error = await refusal(write('deck-x', 'teacher-y'));
    expect(error.code).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(content.put).not.toHaveBeenCalled();
  });

  it('classroom X vs Y: the role is read in the slide row’s classroom, and the file goes to its repo', async () => {
    // teacher-y owns classroom Y; a role there says nothing about deck X.
    member('class-y', 'teacher-x', 'STUDENT');
    await write('deck-x', 'teacher-x');
    expect(content.put.mock.calls[0][0].repo).toBe('content-class-x');
    await write('deck-y', 'teacher-y');
    expect(content.put.mock.calls[1][0].repo).toBe('content-class-y');
    expect(content.put.mock.calls[1][0].path.startsWith('slides/deck-y/blocks/')).toBe(true);
    expect((await refusal(write('deck-y', 'teacher-x'))).code).toBe('forbidden');
  });

  it('students cannot write; the highest of several roles counts', async () => {
    member('class-x', 'student-x', 'STUDENT');
    expect((await refusal(write('deck-x', 'student-x'))).code).toBe('forbidden');
    member('class-x', 'student-x', 'TEACHER');
    await expect(write('deck-x', 'student-x')).resolves.toBeDefined();
  });

  it('assistants: their own decks and allow_team_edit decks only', async () => {
    member('class-x', 'ta-x', 'ASSISTANT');
    expect((await refusal(write('deck-x', 'ta-x'))).code).toBe('forbidden');
    db.slides.set('deck-ta', slide('deck-ta', 'class-x', { created_by: 'ta-x' }));
    await expect(write('deck-ta', 'ta-x')).resolves.toBeDefined();
    db.slides.set('deck-team', slide('deck-team', 'class-x', { allow_team_edit: true }));
    await expect(write('deck-team', 'ta-x')).resolves.toBeDefined();
  });

  it('a locked classroom: only its owner writes, and the refusal names the state', async () => {
    const locked = slide('deck-l', 'class-x');
    locked.classroom.status = 'LOCKED';
    db.slides.set('deck-l', locked);
    member('class-x', 'owner-x', 'OWNER');
    const error = await refusal(write('deck-l', 'teacher-x'));
    expect(error.code).toBe('forbidden');
    expect(error.message).toMatch(/read-only mode/);
    await expect(write('deck-l', 'owner-x')).resolves.toBeDefined();
    // Someone the deck refuses anyway learns nothing about the classroom.
    member('class-x', 'student-x', 'STUDENT');
    expect((await refusal(write('deck-l', 'student-x'))).message).toMatch(/permission/);
  });

  it('an unpublished classroom: the refusal says so', async () => {
    const hidden = slide('deck-u', 'class-x');
    hidden.classroom.status = 'UNPUBLISHED';
    db.slides.set('deck-u', hidden);
    expect((await refusal(write('deck-u', 'teacher-x'))).message).toMatch(/unpublished/);
  });

  it('a missing slide or one that is not a deck is not-found; no signed-in user is forbidden', async () => {
    expect((await refusal(write('nope', 'teacher-x'))).code).toBe('not-found');
    db.slides.set('file-x', slide('file-x', 'class-x', { kind: 'FILE' }));
    expect((await refusal(write('file-x', 'teacher-x'))).code).toBe('not-found');
    expect((await refusal(write('deck-x', ''))).code).toBe('forbidden');
  });

  it('a classroom without a content repo is unavailable', async () => {
    const bare = slide('deck-b', 'class-x');
    bare.classroom.content_repo = null;
    db.slides.set('deck-b', bare);
    expect((await refusal(write('deck-b', 'teacher-x'))).code).toBe('unavailable');
  });
});

describe('readHtmlBlockSource', () => {
  beforeEach(() => {
    content.getMeta.mockResolvedValue({ sha: REV, size: 5 });
    content.getBlobContent.mockResolvedValue({ content: '<p>code</p>', sha: REV });
  });

  it('reads the file by its blob sha (blob API), bound to the path', async () => {
    const result = await readHtmlBlockSource({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      src: 'blocks/0a0b0c0d.html',
      rev: REV,
    });
    expect(result).toEqual({
      src: 'blocks/0a0b0c0d.html',
      html: '<p>code</p>',
      rev: REV,
      stale: false,
    });
    expect(content.getMeta).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'slides/deck-x/blocks/0a0b0c0d.html', skipCache: true })
    );
    expect(content.getBlobContent).toHaveBeenCalledWith(expect.objectContaining({ sha: REV }));
  });

  it('a rev the path no longer holds reads the current version, flagged stale — never the other blob', async () => {
    const result = await readHtmlBlockSource({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      src: 'blocks/0a0b0c0d.html',
      rev: NEW_REV,
    });
    expect(result.stale).toBe(true);
    expect(result.rev).toBe(REV);
    expect(content.getBlobContent).not.toHaveBeenCalledWith(
      expect.objectContaining({ sha: NEW_REV })
    );
  });

  it('only blocks/ files of the deck; a missing file is not-found', async () => {
    expect(
      (
        await refusal(
          readHtmlBlockSource({
            slideId: 'deck-x',
            actorUserId: 'teacher-x',
            src: '../x/index.html',
          })
        )
      ).code
    ).toBe('invalid');
    content.getMeta.mockResolvedValueOnce(null);
    expect(
      (
        await refusal(
          readHtmlBlockSource({
            slideId: 'deck-x',
            actorUserId: 'teacher-x',
            src: 'blocks/0a0b0c0d.html',
          })
        )
      ).code
    ).toBe('not-found');
  });

  it('reads a block file of another deck (a pasted block), but nothing else outside this deck', async () => {
    const result = await readHtmlBlockSource({
      slideId: 'deck-x',
      actorUserId: 'teacher-x',
      src: '../other/blocks/0a0b0c0d.html',
    });
    expect(result.html).toBe('<p>code</p>');
    expect(content.getMeta).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'slides/other/blocks/0a0b0c0d.html' })
    );
    for (const src of [
      '../other/games/x.html',
      '../../pages/p/blocks/0a0b0c0d.html',
      '../other/blocks/0a0b0c0d.html?x=1',
    ]) {
      expect(
        (await refusal(readHtmlBlockSource({ slideId: 'deck-x', actorUserId: 'teacher-x', src })))
          .code
      ).toBe('invalid');
    }
  });

  it('edit access by default; view admits the whole teaching team, never students or other classrooms', async () => {
    member('class-x', 'ta-x', 'ASSISTANT');
    member('class-x', 'student-x', 'STUDENT');
    const read = (actorUserId: string, access?: 'edit' | 'view') =>
      readHtmlBlockSources({
        slideId: 'deck-x',
        actorUserId,
        refs: [{ src: 'blocks/0a0b0c0d.html' }],
        access,
      });
    expect((await refusal(read('ta-x'))).code).toBe('forbidden');
    await expect(read('ta-x', 'view')).resolves.toHaveLength(1);
    expect((await refusal(read('student-x', 'view'))).code).toBe('forbidden');
    expect((await refusal(read('teacher-y', 'view'))).code).toBe('forbidden');
  });
});

describe('deleteHtmlBlockFile', () => {
  it('deletes a blocks/ file, forgets its row, records the folders and audits', async () => {
    content.delete.mockResolvedValue({ commit: 'commit-d' });
    await expect(
      deleteHtmlBlockFile({
        slideId: 'deck-x',
        actorUserId: 'teacher-x',
        src: 'blocks/0a0b0c0d.html',
        blockId: 'b1',
      })
    ).resolves.toEqual({ deleted: true });
    expect(content.delete.mock.calls[0][0]).toMatchObject({
      repo: 'content-class-x',
      path: 'slides/deck-x/blocks/0a0b0c0d.html',
    });
    expect(assets.removeContentAssets).toHaveBeenCalledWith('class-x', [
      'slides/deck-x/blocks/0a0b0c0d.html',
    ]);
    expect(assets.recordFolderTreesAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        commit: 'commit-d',
        folders: ['slides/deck-x', 'slides/deck-x/blocks'],
      })
    );
    expect(auditCreate.mock.calls[0][0]).toMatchObject({
      action: 'DELETE',
      data: {
        tool: 'slides:html_block.delete',
        slide_id: 'deck-x',
        path: 'slides/deck-x/blocks/0a0b0c0d.html',
        block_id: 'b1',
      },
    });
    expect(auditCreate.mock.calls[0][1]).toEqual({ dedupe: false });
  });

  it('a file already gone is not an error', async () => {
    content.delete.mockRejectedValue(new Error('File not found: x'));
    await expect(
      deleteHtmlBlockFile({
        slideId: 'deck-x',
        actorUserId: 'teacher-x',
        src: 'blocks/0a0b0c0d.html',
      })
    ).resolves.toEqual({ deleted: false });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('only blocks/ files of the deck, and only for its editors', async () => {
    for (const src of [
      'games/a/index.html',
      'index.html',
      'deck.json',
      '../deck-y/blocks/0a0b0c0d.html',
    ]) {
      expect(
        (await refusal(deleteHtmlBlockFile({ slideId: 'deck-x', actorUserId: 'teacher-x', src })))
          .code
      ).toBe('invalid');
    }
    expect(
      (
        await refusal(
          deleteHtmlBlockFile({
            slideId: 'deck-x',
            actorUserId: 'teacher-y',
            src: 'blocks/0a0b0c0d.html',
          })
        )
      ).code
    ).toBe('forbidden');
    expect(content.delete).not.toHaveBeenCalled();
  });
});

describe('listRepoFolder', () => {
  it('lists a folder of the slide’s own repo', async () => {
    content.listFolder.mockResolvedValue([
      { name: 'snake', path: 'games/snake', type: 'dir', sha: 's' },
      { name: 'a.html', path: 'games/a.html', type: 'file', sha: 't', size: 9 },
    ]);
    await expect(
      listRepoFolder({ slideId: 'deck-x', actorUserId: 'teacher-x', path: '/games/' })
    ).resolves.toEqual({
      path: 'games',
      deckFolder: 'slides/deck-x',
      entries: [
        { name: 'snake', path: 'games/snake', type: 'dir' },
        { name: 'a.html', path: 'games/a.html', type: 'file', size: 9 },
      ],
    });
    expect(content.listFolder.mock.calls[0][0]).toMatchObject({
      repo: 'content-class-x',
      path: 'games',
    });
  });

  it('refuses paths that leave the repo, and other classrooms', async () => {
    for (const path of ['..', 'games/../..', './x', 'a\\b']) {
      expect(
        (await refusal(listRepoFolder({ slideId: 'deck-x', actorUserId: 'teacher-x', path }))).code
      ).toBe('invalid');
    }
    expect(
      (await refusal(listRepoFolder({ slideId: 'deck-x', actorUserId: 'teacher-y', path: '' })))
        .code
    ).toBe('forbidden');
    expect(content.listFolder).not.toHaveBeenCalled();
  });
});
