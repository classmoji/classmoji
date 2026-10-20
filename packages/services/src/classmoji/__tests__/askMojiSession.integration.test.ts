/**
 * askMojiSession against a REAL Postgres with Trigger stood in: availability
 * reasons, start (no run booted, audited only on a create), ensureSession
 * (the one call that creates the Trigger session), token, state, end and New
 * conversation (sessions closed, audited), and ratings (audited with the
 * rating and impersonated_by). User A vs B and classroom X vs Y throughout.
 *
 * SAFETY: as askMojiTrigger.integration.test.ts (namespaced fixtures, local
 * non-shared database only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const trigger = vi.hoisted(() => ({
  createPublicToken: vi.fn(
    async (o: { scopes: { read: { sessions: string } } }) => `tok:${o.scopes.read.sessions}`
  ),
  close: vi.fn(async () => ({})),
  createStartSessionAction: vi.fn(),
  startCalls: [] as { taskId: string; options: unknown; params: unknown }[],
}));

vi.mock('@trigger.dev/sdk', async importOriginal => ({
  ...(await importOriginal<object>()),
  auth: { createPublicToken: trigger.createPublicToken },
  sessions: { close: trigger.close },
}));
vi.mock('@trigger.dev/sdk/ai', () => ({
  chat: {
    createStartSessionAction:
      (taskId: string, options: unknown) => async (params: { chatId: string }) => {
        trigger.startCalls.push({ taskId, options, params });
        return {
          publicAccessToken: `start:${params.chatId}`,
          sessionId: `session_${params.chatId}`,
          runId: 'run_1',
        };
      },
  },
}));

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const getPrisma = (await import('@classmoji/database')).default;
const session = await import('../askMojiSession.service.ts');
const askMoji = await import('../askMojiChat.service.ts');

describe.skipIf(!RUN)('ask moji session module (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classX: string;
  let classY: string;
  let ownerX: string;
  let userA: string;
  let userB: string;
  let admin: string;
  const userIds: string[] = [];
  const env = { ...process.env };

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `ams-${suite}-${label}@example.test`, name: `AMS ${label}` },
    });
    userIds.push(user.id);
    return user.id;
  };
  const makeClassroom = async (label: string) => {
    const c = await prisma.classroom.create({
      data: {
        slug: `ams-${suite}-${label}`,
        git_org_id: orgId,
        name: `AMS ${label}`,
        content_namespace: `ams-${suite}-${label}`,
        content_repo: `content-ams-${suite}-${label}`,
      },
    });
    await prisma.classroomSettings.create({
      data: { classroom_id: c.id, syllabus_bot_enabled: true },
    });
    await prisma.classroomMembership.create({
      data: { classroom_id: c.id, user_id: ownerX, role: 'OWNER', has_accepted_invite: true },
    });
    return c;
  };

  let X: { id: string; slug: string; status: string };
  let Y: { id: string; slug: string; status: string };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `ams-${suite}`, login: `ams-org-${suite}` },
    });
    orgId = org.id;
    ownerX = await makeUser('owner');
    userA = await makeUser('a');
    userB = await makeUser('b');
    admin = await makeUser('admin');
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
    classX = X.id;
    classY = Y.id;
    for (const [c, u] of [
      [classX, userA],
      [classX, userB],
      [classY, userA],
    ] as const) {
      await prisma.classroomMembership.create({
        data: { classroom_id: c, user_id: u, role: 'STUDENT', has_accepted_invite: true },
      });
    }
    await prisma.subscription.create({ data: { user_id: ownerX, tier: 'PRO' } });
  });

  afterAll(async () => {
    process.env = env;
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  beforeEach(async () => {
    process.env.ASK_MOJI_RUNTIME = 'trigger';
    process.env.TRIGGER_SECRET_KEY = 'tr_test_x';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    trigger.startCalls.length = 0;
    trigger.close.mockClear();
    trigger.createPublicToken.mockClear();
    await prisma.aIConversation.deleteMany({ where: { classroom_id: { in: [classX, classY] } } });
    await prisma.auditLog.deleteMany({ where: { classroom_id: { in: [classX, classY] } } });
  });

  const access = (
    userId: string,
    classroom = X,
    over: Partial<import('../askMojiSession.service.ts').AskMojiAccess> = {}
  ): import('../askMojiSession.service.ts').AskMojiAccess => ({
    userId,
    actorUserId: userId,
    impersonation: null,
    webSessionId: 'web',
    classroom,
    roles: [userId === ownerX ? 'OWNER' : 'STUDENT'],
    highestRole: userId === ownerX ? 'OWNER' : 'STUDENT',
    ...over,
  });
  const impersonated = (userId: string, sessionId = 's1') =>
    access(userId, X, {
      actorUserId: admin,
      impersonation: {
        by: admin,
        sessionId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });

  const audits = (resource_type: string) =>
    prisma.auditLog.findMany({
      where: { classroom_id: classX, resource_type },
      orderBy: { timestamp: 'asc' },
    });

  const started = async (a = access(userA)) => {
    const r = await session.start(a, { tool: 'web:ask_moji.start' });
    if (!r.ok) throw new Error(`refused ${r.code}`);
    return r;
  };

  describe('availability', () => {
    it('names each reason, in order', async () => {
      process.env.ASK_MOJI_RUNTIME = 'ai_agent';
      expect(await session.askMojiAvailable({ classroomId: classX })).toEqual({
        available: false,
        reason: 'RUNTIME_OFF',
      });
      process.env.ASK_MOJI_RUNTIME = 'trigger';
      delete process.env.TRIGGER_SECRET_KEY;
      delete process.env.TRIGGER_ACCESS_TOKEN;
      expect(await session.askMojiAvailable({ classroomId: classX })).toEqual({
        available: false,
        reason: 'TRIGGER_NOT_CONFIGURED',
      });
      process.env.TRIGGER_SECRET_KEY = 'tr_test_x';
      delete process.env.ANTHROPIC_API_KEY;
      expect(await session.askMojiAvailable({ classroomId: classX })).toEqual({
        available: false,
        reason: 'NO_API_KEY',
      });
      await prisma.classroomSettings.update({
        where: { classroom_id: classX },
        data: { anthropic_api_key: 'sk-own' },
      });
      try {
        expect(await session.askMojiAvailable({ classroomId: classX })).toEqual({
          available: true,
        });
      } finally {
        await prisma.classroomSettings.update({
          where: { classroom_id: classX },
          data: { anthropic_api_key: null },
        });
      }
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      await prisma.classroomSettings.update({
        where: { classroom_id: classX },
        data: { syllabus_bot_enabled: false },
      });
      try {
        expect(await session.askMojiAvailable({ classroomId: classX })).toEqual({
          available: false,
          reason: 'NOT_ENABLED',
        });
        expect(await session.start(access(userA), { tool: 't' })).toMatchObject({
          ok: false,
          code: 'NOT_ENABLED',
          reason: 'NOT_ENABLED',
        });
      } finally {
        await prisma.classroomSettings.update({
          where: { classroom_id: classX },
          data: { syllabus_bot_enabled: true },
        });
      }
      await prisma.subscription.updateMany({
        where: { user_id: ownerX },
        data: { ends_at: new Date(Date.now() - 1000) },
      });
      try {
        expect(await session.askMojiAvailable({ classroomId: classX })).toEqual({
          available: false,
          reason: 'PRO_REQUIRED',
        });
        expect(await session.start(access(userA), { tool: 't' })).toMatchObject({
          ok: false,
          code: 'UNAVAILABLE',
          reason: 'PRO_REQUIRED',
        });
      } finally {
        await prisma.subscription.updateMany({
          where: { user_id: ownerX },
          data: { ends_at: null },
        });
      }
    });
  });

  describe('start, ensureSession, token', () => {
    it('creates once (audited), reuses after, and boots no run', async () => {
      const first = await started();
      expect(first).toMatchObject({
        created: true,
        sessionReady: false,
        publicAccessToken: `tok:${first.conversationId}`,
        transcript: [],
        viewAs: 'STUDENT',
        state: { status: 'ACTIVE', inFlight: false, lastMessageId: null },
        ratings: {},
      });
      expect(first.suggestions.length).toBeGreaterThan(0);
      expect(trigger.createPublicToken).toHaveBeenCalledWith({
        scopes: {
          read: { sessions: first.conversationId },
          write: { sessions: first.conversationId },
        },
        expirationTime: '15m',
      });
      const again = await started();
      expect(again).toMatchObject({ created: false, conversationId: first.conversationId });
      expect(trigger.startCalls).toEqual([]);
      const rows = await audits('ASK_MOJI_CONVERSATION');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'CREATE',
        resource_id: first.conversationId,
        user_id: userA,
        role: 'STUDENT',
      });
      expect(rows[0].data).toMatchObject({ tool: 'web:ask_moji.start', view_as: 'STUDENT' });
    });

    it('ensureSession creates and records the session; start then reports it ready', async () => {
      const first = await started();
      expect(
        await session.ensureSession(access(userB), { conversationId: first.conversationId })
      ).toBeNull();
      expect(
        await session.ensureSession(access(userA, Y), { conversationId: first.conversationId })
      ).toBeNull();
      expect(
        await session.ensureSession(impersonated(userA), { conversationId: first.conversationId })
      ).toBeNull();
      const s = await session.ensureSession(access(userA), {
        conversationId: first.conversationId,
      });
      expect(s).toEqual({
        publicAccessToken: `start:${first.conversationId}`,
        sessionId: `session_${first.conversationId}`,
      });
      expect(trigger.startCalls).toEqual([
        {
          taskId: 'ask-moji',
          options: {
            tokenTTL: '15m',
            triggerConfig: {
              tags: [`conversation:${first.conversationId}`, `classroom:${classX}`],
            },
          },
          params: { chatId: first.conversationId },
        },
      ]);
      expect((await started()).sessionReady).toBe(true);
    });

    it('mints a token only for the caller’s own active conversation', async () => {
      const first = await started();
      expect(await session.token(access(userA), { conversationId: first.conversationId })).toEqual({
        publicAccessToken: `tok:${first.conversationId}`,
      });
      expect(
        await session.token(access(userB), { conversationId: first.conversationId })
      ).toBeNull();
      expect(
        await session.token(access(userA, Y), { conversationId: first.conversationId })
      ).toBeNull();
      expect(
        await session.token(impersonated(userA), { conversationId: first.conversationId })
      ).toBeNull();
      expect(
        await session.state(access(userB), { conversationId: first.conversationId })
      ).toBeNull();
      expect(
        await session.state(access(userA), { conversationId: first.conversationId })
      ).toMatchObject({ status: 'ACTIVE' });
    });

    it('an impersonated start gets its own conversation and audits impersonated_by', async () => {
      const own = await started();
      const imp = await started(impersonated(userA));
      expect(imp.conversationId).not.toBe(own.conversationId);
      const rows = await audits('ASK_MOJI_CONVERSATION');
      expect(
        rows.map(r => (r.data as { impersonated_by?: string }).impersonated_by ?? null)
      ).toEqual([null, admin]);
    });
  });

  describe('end and New conversation', () => {
    it('ends once: closes the session and audits', async () => {
      const first = await started();
      await session.ensureSession(access(userA), { conversationId: first.conversationId });
      expect(
        await session.end(access(userB), {
          conversationId: first.conversationId,
          tool: 'web:ask_moji.end',
        })
      ).toEqual({ owned: false, changed: false });
      expect(
        await session.end(access(userA), {
          conversationId: first.conversationId,
          tool: 'web:ask_moji.end',
        })
      ).toEqual({ owned: true, changed: true });
      expect(
        await session.end(access(userA), {
          conversationId: first.conversationId,
          tool: 'web:ask_moji.end',
        })
      ).toEqual({ owned: true, changed: false });
      expect(trigger.close).toHaveBeenCalledTimes(1);
      expect(trigger.close).toHaveBeenCalledWith(first.conversationId);
      const rows = await audits('ASK_MOJI_CONVERSATION');
      expect(rows.map(r => r.action)).toEqual(['CREATE', 'UPDATE']);
    });

    it('closes no Trigger session for a conversation that never had one', async () => {
      const first = await started();
      const next = await session.newConversation(access(userA), {
        conversationId: first.conversationId,
        tool: 'web:ask_moji.new',
      });
      expect(next).toMatchObject({ ok: true, created: true });
      if (!next.ok) return;
      expect(
        await session.end(access(userA), { conversationId: next.conversationId, tool: 't' })
      ).toEqual({ owned: true, changed: true });
      expect(trigger.close).not.toHaveBeenCalled();
    });

    it('New conversation replaces once across devices and closes the old session', async () => {
      const first = await started();
      await session.ensureSession(access(userA), { conversationId: first.conversationId });
      const [n1, n2] = await Promise.all([
        session.newConversation(access(userA), {
          conversationId: first.conversationId,
          tool: 'web:ask_moji.new',
        }),
        session.newConversation(access(userA), {
          conversationId: first.conversationId,
          tool: 'web:ask_moji.new',
        }),
      ]);
      if (!n1.ok || !n2.ok) throw new Error('refused');
      expect(n1.conversationId).toBe(n2.conversationId);
      expect([n1.created, n2.created].sort()).toEqual([false, true]);
      expect(trigger.close).toHaveBeenCalledWith(first.conversationId);
      const creates = (await audits('ASK_MOJI_CONVERSATION')).filter(r => r.action === 'CREATE');
      expect(creates).toHaveLength(2);
      expect(creates[1].data).toMatchObject({
        tool: 'web:ask_moji.new',
        ended_conversation_ids: [first.conversationId],
      });
    });
  });

  describe('unusable conversations', () => {
    it('start closes an expired impersonation’s conversation, its session and audits it', async () => {
      const viewedAs = await started(impersonated(userA));
      await session.ensureSession(impersonated(userA), {
        conversationId: viewedAs.conversationId,
      });
      await prisma.$executeRaw`
        UPDATE ai_conversations
        SET context = jsonb_set(context, '{grant,impersonation,expires_at}',
          to_jsonb(${new Date(Date.now() - 60_000).toISOString()}::text), false)
        WHERE id = ${viewedAs.conversationId}`;
      await prisma.auditLog.deleteMany({ where: { classroom_id: classX } });
      trigger.close.mockClear();

      const mine = await started(access(userA));
      expect(mine.created).toBe(true);
      expect(trigger.close).toHaveBeenCalledWith(viewedAs.conversationId);
      expect(
        (await prisma.aIConversation.findUniqueOrThrow({ where: { id: viewedAs.conversationId } }))
          .status
      ).toBe('COMPLETED');
      // A create lists it in the CREATE row.
      const [created] = await audits('ASK_MOJI_CONVERSATION');
      expect(created).toMatchObject({ action: 'CREATE', resource_id: mine.conversationId });
      expect(created.data).toMatchObject({ ended_conversation_ids: [viewedAs.conversationId] });
    });

    it('without a create, each one closed gets its own UPDATE row', async () => {
      const mine = await started(access(userA));
      const viewedAs = await started(impersonated(userA, 's2'));
      await prisma.$executeRaw`
        UPDATE ai_conversations
        SET context = jsonb_set(context, '{grant,impersonation,expires_at}',
          to_jsonb(${new Date(Date.now() - 60_000).toISOString()}::text), false)
        WHERE id = ${viewedAs.conversationId}`;
      await prisma.auditLog.deleteMany({ where: { classroom_id: classX } });

      const again = await started(access(userA));
      expect(again).toMatchObject({ created: false, conversationId: mine.conversationId });
      const rows = await audits('ASK_MOJI_CONVERSATION');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'UPDATE', resource_id: viewedAs.conversationId });
      expect(rows[0].data).toEqual({
        tool: 'web:ask_moji.start',
        status: 'COMPLETED',
        reason: 'unusable',
      });
    });
  });

  describe('feedback', () => {
    it('audits each real change with the rating and the row id; refuses others', async () => {
      const a = impersonated(userA, 'fb');
      const first = await started(a);
      const q = {
        id: `m${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        role: 'user',
        parts: [{ type: 'text', text: 'Q' }],
      };
      expect(
        (await askMoji.admitUserMessage({ conversationId: first.conversationId, message: q })).ok
      ).toBe(true);
      await askMoji.persistAssistantMessage({
        conversationId: first.conversationId,
        message: { id: 'a:1', role: 'assistant', parts: [{ type: 'text', text: 'A' }] } as never,
      });
      const rate = (rating: unknown, who = a) =>
        session.feedback(who, {
          conversationId: first.conversationId,
          uiMessageId: 'a:1',
          rating,
          tool: 'web:ask_moji.feedback',
        });
      const down = await rate('DOWN');
      expect(down).toMatchObject({ ok: true, rating: 'DOWN', changed: true });
      expect(await rate('DOWN')).toMatchObject({ ok: true, changed: false });
      expect(await rate('UP')).toMatchObject({ ok: true, rating: 'UP', changed: true });
      expect(await rate(null)).toMatchObject({ ok: true, rating: null, changed: true });
      expect(await rate('UP', access(userA))).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rate('UP', access(userB))).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await rate('sideways')).toEqual({ ok: false, code: 'INVALID' });

      const rows = await audits('ASK_MOJI_FEEDBACK');
      expect(rows.map(r => [r.action, (r.data as { value: unknown }).value])).toEqual([
        ['CREATE', 'DOWN'],
        ['UPDATE', 'UP'],
        ['DELETE', null],
      ]);
      expect(new Set(rows.map(r => r.resource_id))).toEqual(new Set([down.ok ? down.id : '']));
      for (const r of rows) {
        expect(r.data).toMatchObject({
          tool: 'web:ask_moji.feedback',
          impersonated_by: admin,
          message_id: 'a:1',
        });
      }
    });
  });
});
