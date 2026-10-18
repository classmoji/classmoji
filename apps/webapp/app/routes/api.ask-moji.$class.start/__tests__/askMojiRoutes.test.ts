import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MOJI_AVAILABILITY_COPY, ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';

/**
 * The seven `api.ask-moji.$class.*` routes: the order of the gates (origin,
 * then auth, then anything else), fixed copy only, and scoping. The services
 * are faked by an in-memory store that answers only for the access the route
 * hands it, the way `askMojiSession` does (its integration tests cover the
 * real rule against the database); these tests prove each route hands it the
 * server-derived access and nothing the client sent.
 */

type Access = {
  userId: string;
  actorUserId: string;
  impersonation: { by: string; sessionId: string | null; expiresAt: string | null } | null;
  webSessionId: string | null;
  classroom: { id: string; slug: string; status: string; name: string };
  roles: string[];
  highestRole: string;
  membership: { role: string };
};

const assertAccessMock = vi.fn();
vi.mock('@classmoji/auth/server', () => ({
  assertAskMojiAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

/** A conversation the fake service holds, with the scope it was started under. */
type Row = {
  id: string;
  userId: string;
  actorUserId: string;
  impersonationSessionId: string | null;
  classroomId: string;
  kind: 'ask_moji' | 'quiz';
};
let rows: Row[] = [];
const calls: { fn: string; access: Access; input: Record<string, unknown> }[] = [];

const owned = (a: Access, conversationId: unknown) =>
  rows.find(
    r =>
      r.id === conversationId &&
      r.kind === 'ask_moji' &&
      r.userId === a.userId &&
      r.actorUserId === a.actorUserId &&
      r.impersonationSessionId === (a.impersonation?.sessionId ?? null) &&
      r.classroomId === a.classroom.id
  ) ?? null;

const availability = vi.fn(
  async (_input?: unknown) => ({ available: true }) as Record<string, unknown>
);
const startImpl = vi.fn();
const throwOn = new Set<string>();

const record = (fn: string, access: Access, input: Record<string, unknown>) => {
  calls.push({ fn, access, input });
  if (throwOn.has(fn)) throw new Error('db://internal-host:5432 constraint ask_moji_secret');
};

const opened = (id: string) => ({
  ok: true,
  conversationId: id,
  publicAccessToken: 'tok',
  sessionReady: false,
  resumeCursor: null,
  transcript: [],
  ratings: {},
  welcome: 'w',
  suggestions: [],
  viewAs: 'STUDENT',
  state: { status: 'ACTIVE', lastMessageId: null, inFlight: false },
  created: true,
});

const auditCreate = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    audit: { create: (...a: unknown[]) => auditCreate(...a) },
    askMojiSession: {
      askMojiAvailable: (i: unknown) => availability(i as never),
      start: async (a: Access, i: Record<string, unknown>) => {
        record('start', a, i);
        return startImpl(a, i) ?? opened('conv-new');
      },
      newConversation: async (a: Access, i: Record<string, unknown>) => {
        record('newConversation', a, i);
        return owned(a, i.conversationId) ? opened('conv-next') : opened('conv-fresh');
      },
      ensureSession: async (a: Access, i: Record<string, unknown>) => {
        record('ensureSession', a, i);
        return owned(a, i.conversationId) ? { publicAccessToken: 'pat', sessionId: 's1' } : null;
      },
      token: async (a: Access, i: Record<string, unknown>) => {
        record('token', a, i);
        return owned(a, i.conversationId) ? { publicAccessToken: 'pat' } : null;
      },
      state: async (a: Access, i: Record<string, unknown>) => {
        record('state', a, i);
        return owned(a, i.conversationId)
          ? {
              status: 'ACTIVE',
              conversationId: i.conversationId,
              lastMessageId: 'm1',
              inFlight: false,
              resumeCursor: null,
            }
          : null;
      },
      end: async (a: Access, i: Record<string, unknown>) => {
        record('end', a, i);
        return owned(a, i.conversationId)
          ? { owned: true, changed: true }
          : { owned: false, changed: false };
      },
      feedback: async (a: Access, i: Record<string, unknown>) => {
        record('feedback', a, i);
        return owned(a, i.conversationId)
          ? { ok: true, id: 'fb1', rating: i.rating, changed: true }
          : { ok: false, code: 'NOT_FOUND' };
      },
    },
  },
}));

const routes = {
  start: await import('../route.ts'),
  new: await import('../../api.ask-moji.$class.new/route.ts'),
  'ensure-session': await import('../../api.ask-moji.$class.ensure-session/route.ts'),
  token: await import('../../api.ask-moji.$class.token/route.ts'),
  state: await import('../../api.ask-moji.$class.state/route.ts'),
  end: await import('../../api.ask-moji.$class.end/route.ts'),
  feedback: await import('../../api.ask-moji.$class.feedback/route.ts'),
};
type RouteName = keyof typeof routes;

const ORIGIN = 'http://localhost:3000';

const makeRequest = (
  name: RouteName,
  body: unknown,
  { origin = ORIGIN, method = 'POST' }: { origin?: string | null; method?: string } = {}
) =>
  new Request(`${ORIGIN}/api/ask-moji/cs-x/${name}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { origin } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });

const call = async (
  name: RouteName,
  body: unknown = {},
  opts?: { origin?: string | null; method?: string; request?: Request }
) => {
  const request = opts?.request ?? makeRequest(name, body, opts);
  const response = (await routes[name].action({
    request,
    params: { class: 'cs-x' },
  } as never)) as Response;
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const access = (
  userId: string,
  {
    classroomId = 'class-x',
    roles = ['STUDENT'],
    impersonatedBy,
  }: { classroomId?: string; roles?: string[]; impersonatedBy?: string } = {}
): Access => ({
  userId,
  actorUserId: impersonatedBy ?? userId,
  impersonation: impersonatedBy
    ? { by: impersonatedBy, sessionId: 'imp-session', expiresAt: null }
    : null,
  webSessionId: impersonatedBy ? 'imp-session' : 'web-session',
  classroom: { id: classroomId, slug: 'cs-x', status: 'ACTIVE', name: 'CS X' },
  roles,
  highestRole: roles[0],
  membership: { role: roles[0] },
});

const signInAs = (a: Access) => assertAccessMock.mockResolvedValue(a);

const CONVERSATION_ROUTES: { name: RouteName; body: Record<string, unknown> }[] = [
  { name: 'ensure-session', body: {} },
  { name: 'token', body: {} },
  { name: 'state', body: { knownLastMessageId: null } },
  { name: 'end', body: {} },
  { name: 'feedback', body: { uiMessageId: 'msg:1', rating: 'UP' } },
];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [
    {
      id: 'conv-a',
      userId: 'user-a',
      actorUserId: 'user-a',
      impersonationSessionId: null,
      classroomId: 'class-x',
      kind: 'ask_moji',
    },
    {
      id: 'attempt-1',
      userId: 'user-a',
      actorUserId: 'user-a',
      impersonationSessionId: null,
      classroomId: 'class-x',
      kind: 'quiz',
    },
  ];
  calls.length = 0;
  throwOn.clear();
  startImpl.mockReturnValue(undefined);
  availability.mockResolvedValue({ available: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gate order', () => {
  for (const name of Object.keys(routes) as RouteName[]) {
    it(`${name}: a cross-origin POST is refused before auth and before any service call`, async () => {
      signInAs(access('user-a'));
      const res = await call(
        name,
        { conversationId: 'conv-a' },
        { origin: 'https://evil.example' }
      );
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ ok: false, code: 'ERROR', message: ASK_MOJI_COPY.ERROR });
      expect(assertAccessMock).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(availability).not.toHaveBeenCalled();
    });

    it(`${name}: auth runs before the body is read or any service is called`, async () => {
      assertAccessMock.mockRejectedValue(
        new Response('Not a member of this classroom', { status: 403 })
      );
      const request = makeRequest(name, { conversationId: 'conv-a' });
      const textSpy = vi.spyOn(request, 'text');
      const jsonSpy = vi.spyOn(request, 'json');
      const res = await call(name, undefined, { request });
      expect(res.status).toBe(403);
      // Fixed copy, never the gate's own text.
      expect(res.body).toEqual({
        ok: false,
        code: 'UNAVAILABLE',
        message: ASK_MOJI_COPY.UNAVAILABLE,
      });
      expect(textSpy).not.toHaveBeenCalled();
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
      expect(availability).not.toHaveBeenCalled();
    });

    it(`${name}: signed out is 401 with fixed copy`, async () => {
      assertAccessMock.mockRejectedValue(new Response('Unauthorized', { status: 401 }));
      const res = await call(name, { conversationId: 'conv-a' });
      expect(res.status).toBe(401);
      expect(res.body.message).toBe(ASK_MOJI_COPY.UNAVAILABLE);
      expect(calls).toHaveLength(0);
    });

    it(`${name}: GET is 405`, async () => {
      const res = await call(name, undefined, { method: 'GET' });
      expect(res.status).toBe(405);
      expect(assertAccessMock).not.toHaveBeenCalled();
    });
  }

  it('the access gate is asked for the URL classroom, as ASK_MOJI', async () => {
    signInAs(access('user-a'));
    await call('start');
    expect(assertAccessMock).toHaveBeenCalledWith(expect.any(Request), 'cs-x', {
      resourceType: 'ASK_MOJI',
      action: 'start',
    });
  });
});

describe('fixed copy only', () => {
  it('an unexpected error answers the generic line, never its detail', async () => {
    signInAs(access('user-a'));
    throwOn.add('state');
    const res = await call('state', { conversationId: 'conv-a' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, code: 'ERROR', message: ASK_MOJI_COPY.ERROR });
    expect(JSON.stringify(res.body)).not.toContain('internal-host');
  });

  it('a malformed body is 400 with fixed copy', async () => {
    signInAs(access('user-a'));
    const request = new Request(`${ORIGIN}/api/ask-moji/cs-x/state`, {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: '{not json',
    });
    const res = await call('state', undefined, { request });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(ASK_MOJI_COPY.INVALID_MESSAGE);
  });

  it('feedback refuses a rating outside UP / DOWN / null', async () => {
    signInAs(access('user-a'));
    const res = await call('feedback', {
      conversationId: 'conv-a',
      uiMessageId: 'm',
      rating: 'MEH',
    });
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('scoping: every id the service sees is checked against the server-derived access', () => {
  it('the owner gets their conversation on every route', async () => {
    signInAs(access('user-a'));
    for (const { name, body } of CONVERSATION_ROUTES) {
      const res = await call(name, { conversationId: 'conv-a', ...body });
      expect(res.status, name).toBe(200);
    }
  });

  it('user B on user A’s conversation: the same 404 as an id that does not exist', async () => {
    for (const { name, body } of CONVERSATION_ROUTES) {
      signInAs(access('user-b'));
      const theirs = await call(name, { conversationId: 'conv-a', ...body });
      const missing = await call(name, { conversationId: 'no-such-id', ...body });
      expect(theirs.status, name).toBe(404);
      expect(theirs.body, name).toEqual(missing.body);
      expect(theirs.body).toEqual({
        ok: false,
        code: 'NOT_FOUND',
        message: ASK_MOJI_COPY.NOT_FOUND,
      });
    }
  });

  it('classroom Y’s URL cannot reach a conversation of classroom X', async () => {
    for (const { name, body } of CONVERSATION_ROUTES) {
      signInAs(access('user-a', { classroomId: 'class-y' }));
      const res = await call(name, { conversationId: 'conv-a', ...body });
      expect(res.status, name).toBe(404);
    }
  });

  it('a quiz attempt id is refused like any other id', async () => {
    signInAs(access('user-a'));
    for (const { name, body } of CONVERSATION_ROUTES) {
      const res = await call(name, { conversationId: 'attempt-1', ...body });
      expect(res.status, name).toBe(404);
    }
  });

  it('an impersonated session never reaches the real user’s conversation, nor the reverse', async () => {
    signInAs(access('user-a', { impersonatedBy: 'admin-1' }));
    for (const { name, body } of CONVERSATION_ROUTES) {
      const res = await call(name, { conversationId: 'conv-a', ...body });
      expect(res.status, name).toBe(404);
    }
    rows.push({
      id: 'conv-imp',
      userId: 'user-a',
      actorUserId: 'admin-1',
      impersonationSessionId: 'imp-session',
      classroomId: 'class-x',
      kind: 'ask_moji',
    });
    expect((await call('state', { conversationId: 'conv-imp' })).status).toBe(200);
    signInAs(access('user-a'));
    for (const { name, body } of CONVERSATION_ROUTES) {
      const res = await call(name, { conversationId: 'conv-imp', ...body });
      expect(res.status, name).toBe(404);
    }
  });

  it('client-sent identity fields never reach the service', async () => {
    const a = access('user-a');
    signInAs(a);
    await call('start', { viewAs: 'STUDENT', userId: 'user-b', classroomId: 'class-y' });
    await call('state', { conversationId: 'conv-a', userId: 'user-b', classroomId: 'class-y' });
    for (const c of calls) {
      expect(c.access).toBe(a);
      expect(c.input).not.toHaveProperty('userId');
      expect(c.input).not.toHaveProperty('classroomId');
    }
  });

  it('start passes the view and zone through, with the web tool name', async () => {
    signInAs(access('user-a'));
    await call('start', { viewAs: 'TEACHER', browserTimeZone: 'America/New_York' });
    expect(calls[0].input).toEqual({
      viewAs: 'TEACHER',
      browserTimeZone: 'America/New_York',
      tool: 'web:ask_moji.start',
    });
    await call('start', { viewAs: 'ROOT' });
    expect(calls[1].input.viewAs).toBeUndefined();
  });
});

describe('scoping: start and New conversation (user B, classroom Y)', () => {
  /** The service answers start per caller and classroom, as askMojiSession does. */
  const perScope = (a: Access) => opened(`conv-${a.userId}-${a.classroom.id}`);

  it('start opens the caller’s own conversation for the URL’s classroom, never one the body names', async () => {
    startImpl.mockImplementation(perScope);
    signInAs(access('user-a'));
    const mine = await call('start', { conversationId: 'conv-b', userId: 'user-b' });
    signInAs(access('user-b'));
    const theirs = await call('start');
    signInAs(access('user-a', { classroomId: 'class-y' }));
    const otherClass = await call('start');
    expect(mine.body.conversationId).toBe('conv-user-a-class-x');
    expect(theirs.body.conversationId).toBe('conv-user-b-class-x');
    expect(otherClass.body.conversationId).toBe('conv-user-a-class-y');
    for (const c of calls.filter(c => c.fn === 'start')) {
      expect(c.input).not.toHaveProperty('conversationId');
      expect(c.input).not.toHaveProperty('userId');
    }
  });

  it('user B’s New conversation on user A’s conversation replaces nothing of A’s', async () => {
    signInAs(access('user-b'));
    const res = await call('new', { conversationId: 'conv-a' });
    expect(res.status).toBe(200);
    // Not A's replacement: the service saw B's access and found no conversation of B's.
    expect(res.body.conversationId).toBe('conv-fresh');
    const sent = calls.find(c => c.fn === 'newConversation')!;
    expect(sent.access.userId).toBe('user-b');
    expect(sent.input).toEqual({
      conversationId: 'conv-a',
      viewAs: undefined,
      browserTimeZone: undefined,
      tool: 'web:ask_moji.new',
    });
  });

  it('classroom Y’s New conversation cannot replace classroom X’s conversation', async () => {
    signInAs(access('user-a', { classroomId: 'class-y' }));
    const res = await call('new', { conversationId: 'conv-a' });
    expect(res.body.conversationId).toBe('conv-fresh');
    expect(calls.at(-1)!.access.classroom.id).toBe('class-y');
  });

  it('an impersonated New conversation cannot replace the real user’s conversation', async () => {
    signInAs(access('user-a', { impersonatedBy: 'admin-1' }));
    const res = await call('new', { conversationId: 'conv-a' });
    expect(res.body.conversationId).toBe('conv-fresh');
  });

  it('the owner’s New conversation replaces their own', async () => {
    signInAs(access('user-a'));
    expect((await call('new', { conversationId: 'conv-a' })).body.conversationId).toBe('conv-next');
  });
});

describe('ensure-session: bookkeeping, not an audited action', () => {
  it('starting the caller’s own session writes no audit row from the route', async () => {
    signInAs(access('user-a'));
    const res = await call('ensure-session', { conversationId: 'conv-a' });
    expect(res.status).toBe(200);
    expect(calls.map(c => c.fn)).toEqual(['ensureSession']);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('unavailable: why, for staff only', () => {
  const refusal = { ok: false, code: 'UNAVAILABLE', permanent: false, reason: 'PRO_REQUIRED' };

  it('a student sees the members’ line and no reason', async () => {
    signInAs(access('user-a'));
    startImpl.mockReturnValue(refusal);
    const res = await call('start');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      code: 'UNAVAILABLE',
      message: ASK_MOJI_COPY.UNAVAILABLE,
      permanent: false,
    });
  });

  it('an assistant sees no reason either', async () => {
    signInAs(access('user-a', { roles: ['ASSISTANT'] }));
    startImpl.mockReturnValue(refusal);
    const res = await call('start');
    expect(res.body.reason).toBeUndefined();
    expect(res.body.staffMessage).toBeUndefined();
  });

  it('an owner or teacher (even viewing as a student) sees the reason and its staff line', async () => {
    for (const roles of [['OWNER'], ['TEACHER', 'STUDENT']]) {
      signInAs(access('user-a', { roles }));
      startImpl.mockReturnValue(refusal);
      const res = await call('start', { viewAs: 'STUDENT' });
      expect(res.body.reason).toBe('PRO_REQUIRED');
      expect(res.body.staffMessage).toBe(ASK_MOJI_AVAILABILITY_COPY.PRO_REQUIRED);
      expect(res.body.message).toBe(ASK_MOJI_COPY.UNAVAILABLE);
    }
  });

  it('ensure-session boots nothing while Ask Moji is unavailable', async () => {
    signInAs(access('user-a'));
    availability.mockResolvedValue({ available: false, reason: 'NOT_ENABLED' });
    const res = await call('ensure-session', { conversationId: 'conv-a' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ENABLED');
    expect(calls.find(c => c.fn === 'ensureSession')).toBeUndefined();
  });
});

describe('response shapes', () => {
  it('ensure-session and token return the token only', async () => {
    signInAs(access('user-a'));
    expect((await call('ensure-session', { conversationId: 'conv-a' })).body).toEqual({
      publicAccessToken: 'pat',
    });
    expect((await call('token', { conversationId: 'conv-a' })).body).toEqual({
      publicAccessToken: 'pat',
    });
  });

  it('end and feedback answer ok with what changed', async () => {
    signInAs(access('user-a'));
    expect((await call('end', { conversationId: 'conv-a' })).body).toEqual({
      ok: true,
      changed: true,
    });
    expect(
      (await call('feedback', { conversationId: 'conv-a', uiMessageId: 'msg:1', rating: null }))
        .body
    ).toEqual({ ok: true, rating: null, changed: true });
    expect(calls.at(-1)!.input.tool).toBe('web:ask_moji.feedback');
  });

  it('new needs the conversation it replaces', async () => {
    signInAs(access('user-a'));
    expect((await call('new', {})).status).toBe(400);
    const res = await call('new', { conversationId: 'conv-a' });
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toBe('conv-next');
    expect(calls.at(-1)!.input.tool).toBe('web:ask_moji.new');
  });
});
