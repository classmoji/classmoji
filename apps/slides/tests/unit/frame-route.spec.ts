/**
 * `/:slideId/frame/*` — the editor's frame source (`frameRoute.server`).
 *
 * The slide lookup and the view gate are injected (the real ones need
 * Postgres; `assertSlideAccess` has its own tests). The fake gate keeps the
 * real rule's shape — public decks open to anyone, private ones to members,
 * drafts to staff — so what is pinned here is the ROUTE's wiring: the gate is
 * asked about the slide the URL names, before anything else; the repo, the
 * classroom and the deck folder come from that slide's row, never from the
 * URL; only a deck is served; and what cannot be signed is a 404.
 */

import { test, expect } from '@playwright/test';
import { frameRedirect, type FrameRouteDeps } from '../../app/utils/frameRoute.server.ts';

const CLASSROOM_X = '11111111-2222-3333-4444-555555555555';
const CLASSROOM_Y = '99999999-2222-3333-4444-555555555555';
const ORIGIN = 'https://content-staging.classmoji.io';

const org = (login: string) => ({
  login,
  provider: 'GITHUB',
  github_installation_id: '42',
  gitlab_connection_id: null,
});

function slideRow(
  id: string,
  classroomId: string,
  opts: { public?: boolean; draft?: boolean; kind?: string; folder?: string } = {}
) {
  return {
    id,
    kind: opts.kind ?? 'DECK',
    content_path: opts.folder ?? `slides/${id}`,
    is_public: opts.public ?? false,
    is_draft: opts.draft ?? false,
    classroom_id: classroomId,
    classroom: {
      id: classroomId,
      content_key_version: 1,
      content_repo: classroomId === CLASSROOM_X ? 'content-x' : 'content-y',
      content_delivery_enabled: true,
      git_organization: org(classroomId === CLASSROOM_X ? 'org-x' : 'org-y'),
    },
  };
}

const SLIDES = new Map(
  [
    slideRow('deck-x', CLASSROOM_X),
    slideRow('public-x', CLASSROOM_X, { public: true }),
    slideRow('draft-x', CLASSROOM_X, { draft: true }),
    slideRow('file-x', CLASSROOM_X, { kind: 'FILE' }),
    slideRow('deck-y', CLASSROOM_Y),
  ].map(row => [row.id, row])
);

/** user → classroom → role */
const MEMBERS: Record<string, Record<string, string>> = {
  'user-a': { [CLASSROOM_X]: 'STUDENT' },
  'user-b': { [CLASSROOM_Y]: 'STUDENT' },
  'staff-x': { [CLASSROOM_X]: 'TEACHER' },
};

type Row = ReturnType<typeof slideRow>;

function deps() {
  const calls = { gate: [] as string[], sign: [] as Array<Record<string, unknown>> };
  const d: FrameRouteDeps = {
    findSlide: async id => (SLIDES.get(id) as never) ?? null,
    async assertView(request, slide) {
      const row = slide as unknown as Row;
      calls.gate.push(row.id);
      const user = request.headers.get('x-test-user');
      const role = user ? MEMBERS[user]?.[row.classroom_id] : undefined;
      const staff = role === 'TEACHER' || role === 'OWNER' || role === 'ASSISTANT';
      const allowed = row.is_draft ? staff : row.is_public || Boolean(role);
      if (!allowed) throw new Response('Access denied', { status: 403 });
    },
    frameSigner(ctx, frames) {
      return {
        async sign(repoPath, query) {
          calls.sign.push({
            classroomId: ctx.classroom.id,
            repo: ctx.classroom.content_repo,
            deckFolder: frames.deckFolder,
            isPublic: frames.isPublic,
            repoPath,
            query,
          });
          if (repoPath.includes('missing')) return null;
          return `${ORIGIN}/c/${ctx.classroom.id}/files/G/week.1.2.sig/${repoPath}${query}`;
        },
      };
    },
  };
  return { d, calls };
}

let savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['CONTENT_SIGNING_SECRET', 'CONTENT_DELIVERY_ORIGIN'] as const;
test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.CONTENT_SIGNING_SECRET = 'test-master-secret';
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
});
test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function get(slideId: string, rest: string, user?: string) {
  const { d, calls } = deps();
  const request = new Request(`https://slides.classmoji.io/${slideId}/frame/${rest}`, {
    headers: user ? { 'x-test-user': user } : {},
  });
  let response: Response;
  try {
    response = await frameRedirect({ params: { slideId, '*': rest }, request }, d);
  } catch (thrown) {
    if (!(thrown instanceof Response)) throw thrown;
    response = thrown;
  }
  return { response, calls };
}

test.describe('the frame route', () => {
  test('a member is redirected to a fresh signature, never cached, cm-rev dropped', async () => {
    const { response, calls } = await get(
      'deck-x',
      'slides/deck-x/blocks/ab12cd34.html?cm-rev=abc&x=1',
      'user-a'
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Location')).toBe(
      `${ORIGIN}/c/${CLASSROOM_X}/files/G/week.1.2.sig/slides/deck-x/blocks/ab12cd34.html?x=1`
    );
    expect(calls.sign).toEqual([
      {
        classroomId: CLASSROOM_X,
        repo: 'content-x',
        deckFolder: 'slides/deck-x',
        isPublic: false,
        repoPath: 'slides/deck-x/blocks/ab12cd34.html',
        query: '?x=1',
      },
    ]);
  });

  test('user A vs B: a member of another classroom is refused before anything is signed', async () => {
    const { response, calls } = await get('deck-x', 'slides/deck-x/games/a.html', 'user-b');
    expect(response.status).toBe(403);
    expect(calls.gate).toEqual(['deck-x']);
    expect(calls.sign).toEqual([]);
  });

  test('classroom X vs Y: a slide of Y only ever signs inside Y', async () => {
    // B names X's deck folder through Y's slide; the signer is still Y's.
    const { response, calls } = await get('deck-y', 'slides/deck-x/games/a.html', 'user-b');
    expect(response.status).toBe(302);
    expect(calls.sign[0]).toMatchObject({
      classroomId: CLASSROOM_Y,
      repo: 'content-y',
      deckFolder: 'slides/deck-y',
    });
    expect(response.headers.get('Location')).toContain(`/c/${CLASSROOM_Y}/`);
  });

  test('anonymous: only a public deck, and only its own', async () => {
    const open = await get('public-x', 'slides/public-x/games/a.html');
    expect(open.response.status).toBe(302);
    expect(open.calls.sign[0]).toMatchObject({ deckFolder: 'slides/public-x', isPublic: true });

    const closed = await get('deck-x', 'slides/deck-x/games/a.html');
    expect(closed.response.status).toBe(403);
    expect(closed.calls.sign).toEqual([]);
  });

  test('a draft is for staff', async () => {
    expect((await get('draft-x', 'slides/draft-x/a.html', 'user-a')).response.status).toBe(403);
    expect((await get('draft-x', 'slides/draft-x/a.html', 'staff-x')).response.status).toBe(302);
  });

  test('404s: unknown slide, not a deck, unsignable, encoded separator', async () => {
    expect((await get('nope', 'a/b.html', 'user-a')).response.status).toBe(404);
    const file = await get('file-x', 'slides/file-x/doc.pdf', 'user-a');
    expect(file.response.status).toBe(404);
    expect(file.calls.gate).toEqual(['file-x']);
    const missing = await get('deck-x', 'slides/deck-x/missing.html', 'user-a');
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get('Cache-Control')).toBe('no-store');
    // An encoded separator would change which folder is meant: refused.
    const encoded = await get('deck-x', 'slides%2Fdeck-x%2F..%2Fx.html', 'user-a');
    expect(encoded.response.status).toBe(404);
    expect(encoded.calls.sign).toEqual([]);
  });

  test('dot segments are resolved by the URL before the route sees them', async () => {
    // `..` can only climb within the frame path (the URL parser resolves it),
    // and the signer is handed a clean repo path — which it then judges.
    const { calls } = await get('deck-x', 'slides/deck-x/%2e%2e/%2e%2e/x.html', 'user-a');
    expect(calls.sign.map(call => call.repoPath)).toEqual(['x.html']);
  });

  test('the route module is a resource route over this helper', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../app/routes/$slideId_.frame.$/route.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toContain('frameRedirect({ params, request })');
    expect(source).not.toContain('export default');
  });
});
