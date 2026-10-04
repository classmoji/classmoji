/**
 * page_cursor_set / deck_cursor_set: the agent points at text or a slide in a
 * live document through the collab server's `/cursor` (no content change).
 * Gated like the apply tools; the actor carries the MCP session so each agent
 * session is its own presence. The collab internal API is a stubbed `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  pageFindById: vi.fn(),
  slideFindById: vi.fn(),
  userFindById: vi.fn(),
  findMembership: vi.fn(),
}));

vi.mock('@classmoji/services/slides', () => ({
  slideService: { findById: (...a: unknown[]) => mocks.slideFindById(...a) },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: { findById: (...a: unknown[]) => mocks.pageFindById(...a) },
    user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findMembership(...a),
    },
  },
}));

const { pageCursorSetTool, deckCursorSetTool } = await import('../liveCursor.ts');

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const DECK_ID = '33333333-3333-4333-8333-333333333333';
const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-test-org-cs101',
  git_organization: { provider: 'GITHUB', login: 'test-org' },
  collab_enabled: true,
};
const PAGE = {
  id: PAGE_ID,
  classroom_id: 'class-1',
  content_path: 'pages/p',
  classroom: CLASSROOM,
};
const DECK = {
  id: DECK_ID,
  classroom_id: 'class-1',
  content_path: 'slides/d',
  created_by: 'teacher-1',
  allow_team_edit: false,
  classroom: CLASSROOM,
};

const ctx = (role = 'TEACHER', agentSession: string | null = 'mcp-session-1') =>
  ({
    viewer: {
      userId: 'teacher-1',
      clientId: 'c',
      scopes: new Set(['read', 'write']),
      agentSession,
    },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {} },
    },
  }) as unknown as ToolContext;

interface Call {
  path: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { shown: true },
});

const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const call = {
    path: new URL(String(url)).pathname,
    body: JSON.parse(String(init?.body ?? '{}')),
  };
  calls.push(call);
  const { status, body } = respond(call);
  return new Response(JSON.stringify(body), { status });
});

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  calls = [];
  respond = () => ({ status: 200, body: { shown: true } });
  vi.stubGlobal('fetch', fakeFetch);
  mocks.pageFindById.mockResolvedValue(PAGE);
  mocks.slideFindById.mockResolvedValue(DECK);
  mocks.userFindById.mockResolvedValue({ id: 'teacher-1', name: 'Ada Lovelace' });
  mocks.findMembership.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('page_cursor_set', () => {
  it('sends the caret, a selection end and the agent session; changes nothing else', async () => {
    const result = await pageCursorSetTool.handler(
      {
        classroom: 'org/x',
        page_id: PAGE_ID,
        block_id: 'p1',
        offset: 4,
        select_to: { block_id: 'p2', at: 'end' },
      },
      ctx()
    );
    expect(parse(result)).toEqual({ success: true, shown: true });
    expect(calls).toEqual([
      {
        path: `/internal/page/${PAGE_ID}/cursor`,
        body: {
          actor: { userId: 'teacher-1', name: 'Ada Lovelace', agentSession: 'mcp-session-1' },
          page: { blockId: 'p1', offset: 4, selectTo: { blockId: 'p2', at: 'end' } },
        },
      },
    ]);
  });

  it('says so when nobody has the page open', async () => {
    respond = () => ({ status: 200, body: { shown: false } });
    const result = parse(
      await pageCursorSetTool.handler(
        { classroom: 'org/x', page_id: PAGE_ID, block_id: 'p1', at: 'start' },
        ctx('TEACHER', null)
      )
    );
    expect(result).toMatchObject({ success: true, shown: false });
    expect(result.note).toMatch(/Nobody has it open/);
    // No session id from the client: the actor has none either.
    expect(calls[0].body.actor).toEqual({ userId: 'teacher-1', name: 'Ada Lovelace' });
  });

  it('names a block that is not in the live page', async () => {
    respond = () => ({ status: 404, body: { error: 'not-found', what: 'block' } });
    await expect(
      pageCursorSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, block_id: 'gone' }, ctx())
    ).rejects.toMatchObject({ kind: 'not_found', message: expect.stringContaining("'gone'") });
  });

  it('refuses a classroom that does not edit live, without calling collab', async () => {
    mocks.pageFindById.mockResolvedValue({
      ...PAGE,
      classroom: { ...CLASSROOM, collab_enabled: false },
    });
    await expect(
      pageCursorSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, block_id: 'p1' }, ctx())
    ).rejects.toMatchObject({ code: 'LIVE_ONLY' });
    expect(calls).toEqual([]);
  });

  it('refuses a page from another classroom (S1)', async () => {
    mocks.pageFindById.mockResolvedValue({ ...PAGE, classroom_id: 'other' });
    await expect(
      pageCursorSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, block_id: 'p1' }, ctx())
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(calls).toEqual([]);
  });

  it('maps an unreachable collab server like a live write', async () => {
    respond = () => ({ status: 503, body: { error: 'unavailable' } });
    await expect(
      pageCursorSetTool.handler({ classroom: 'org/x', page_id: PAGE_ID, block_id: 'p1' }, ctx())
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
  });
});

describe('deck_cursor_set', () => {
  it('points at a slide', async () => {
    const result = await deckCursorSetTool.handler(
      { classroom: 'org/x', slide_id: DECK_ID, slide: 'aaa' },
      ctx()
    );
    expect(parse(result)).toEqual({ success: true, shown: true });
    expect(calls).toEqual([
      {
        path: `/internal/deck/${DECK_ID}/cursor`,
        body: {
          actor: { userId: 'teacher-1', name: 'Ada Lovelace', agentSession: 'mcp-session-1' },
          slide: 'aaa',
        },
      },
    ]);
  });

  it('an assistant may only point in decks they may edit', async () => {
    mocks.slideFindById.mockResolvedValue({ ...DECK, created_by: 'someone-else' });
    await expect(
      deckCursorSetTool.handler(
        { classroom: 'org/x', slide_id: DECK_ID, slide: 'aaa' },
        ctx('ASSISTANT')
      )
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(calls).toEqual([]);

    mocks.slideFindById.mockResolvedValue({ ...DECK, created_by: 'teacher-1' });
    await deckCursorSetTool.handler(
      { classroom: 'org/x', slide_id: DECK_ID, slide: 'aaa' },
      ctx('ASSISTANT')
    );
    expect(calls).toHaveLength(1);
  });

  it('names a slide that is not in the live deck', async () => {
    respond = () => ({ status: 404, body: { error: 'not-found', what: 'slide' } });
    await expect(
      deckCursorSetTool.handler({ classroom: 'org/x', slide_id: DECK_ID, slide: 'zzz' }, ctx())
    ).rejects.toMatchObject({ kind: 'not_found', message: expect.stringContaining("'zzz'") });
  });

  it('refuses a deck in a classroom that does not edit live', async () => {
    mocks.slideFindById.mockResolvedValue({
      ...DECK,
      classroom: { ...CLASSROOM, collab_enabled: false },
    });
    await expect(
      deckCursorSetTool.handler({ classroom: 'org/x', slide_id: DECK_ID, slide: 'aaa' }, ctx())
    ).rejects.toMatchObject({ code: 'LIVE_ONLY' });
  });
});

describe('tool definitions', () => {
  it.each([pageCursorSetTool, deckCursorSetTool])(
    '$name: write-gated like its apply tool, annotated, description under 1,500 bytes',
    tool => {
      expect(tool.scope).toBe('write');
      expect(tool.annotations).toEqual({ destructive: false, idempotent: true, openWorld: false });
      expect(Buffer.byteLength(tool.description, 'utf8')).toBeLessThan(1500);
    }
  );

  it('uses the same role tiers as page_content_apply / deck_apply', () => {
    expect(pageCursorSetTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(deckCursorSetTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
  });
});
