/**
 * askMojiChat.service against a REAL Postgres: the conversation row lock
 * (`SELECT … FOR UPDATE`), the per-user start lock, the `context` JSON
 * (grant vs legacy rows, per-key runtime writes), the
 * `(conversation_id, ui_message_id)` key, and the cross-user and
 * cross-classroom scoping every read and write must hold.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classroom →
 * conversations → messages) and the users. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL database that is not the shared
 * `classmoji` dev database (the house rule; see forms.integration.test.ts).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const getPrisma = (await import('@classmoji/database')).default;
const askMoji = await import('../askMojiChat.service.ts');
const { CONTRACT_VERSION, START_RATE_LIMIT, MAX_MESSAGE_CHARS } =
  await import('@classmoji/utils/ask-moji');

describe.skipIf(!RUN)('ask moji chat service (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId: string;
  let classX: string;
  let classY: string;
  let ownerX: string;
  let userA: string;
  let userB: string;
  let taStudent: string;
  const userIds: string[] = [];

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `amoji-${suite}-${label}@example.test`, name: `Ask Moji ${label}` },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string, ownerId: string) => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `amoji-${suite}-${label}`,
        git_org_id: orgId,
        name: `Ask Moji ${label}`,
        content_namespace: `amoji-${suite}-${label}`,
        content_repo: `content-amoji-${suite}-${label}`,
      },
    });
    await prisma.classroomSettings.create({
      data: { classroom_id: classroom.id, syllabus_bot_enabled: true },
    });
    await prisma.classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: ownerId,
        role: 'OWNER',
        has_accepted_invite: true,
      },
    });
    return classroom.id;
  };

  const join = (classroomId: string, userId: string, role: 'STUDENT' | 'ASSISTANT' | 'TEACHER') =>
    prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: userId, role, has_accepted_invite: true },
    });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `amoji-${suite}`, login: `amoji-org-${suite}` },
    });
    orgId = org.id;
    ownerX = await makeUser('owner');
    userA = await makeUser('a');
    userB = await makeUser('b');
    taStudent = await makeUser('ta-student');
    classX = await makeClassroom('x', ownerX);
    classY = await makeClassroom('y', ownerX);
    await join(classX, userA, 'STUDENT');
    await join(classX, userB, 'STUDENT');
    await join(classY, userA, 'STUDENT');
    await join(classX, taStudent, 'ASSISTANT');
    await join(classX, taStudent, 'STUDENT');
    // canUseSyllabusBot: the classrooms' owner holds an active Pro subscription.
    await prisma.subscription.create({ data: { user_id: ownerX, tier: 'PRO' } });
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) await prisma.user.delete({ where: { id } }).catch(() => {});
  });

  // Each test starts from no conversations, so the start rate limit and the
  // close-older rule only see what the test made.
  beforeEach(async () => {
    await prisma.aIConversation.deleteMany({ where: { classroom_id: { in: [classX, classY] } } });
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  type Grant = Parameters<typeof askMoji.create>[0]['grant'];

  const grantFor = (userId: string, classroomId: string, over: Partial<Grant> = {}): Grant => ({
    actor_user_id: userId,
    effective_user_id: userId,
    classroom_id: classroomId,
    role: 'STUDENT',
    web_session_id: 'web-session',
    impersonation: null,
    issued_at: new Date().toISOString(),
    view_as: 'STUDENT',
    role_ceiling: 'STUDENT',
    browser_timezone: 'America/New_York',
    ...over,
  });

  const start = async (userId: string, classroomId: string, over: Partial<Grant> = {}) => {
    const result = await askMoji.create({ grant: grantFor(userId, classroomId, over) });
    if (!result.ok) throw new Error(`create refused: ${result.code}`);
    return result.conversationId;
  };

  const msgId = () => `m${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const userMessage = (text: string, id = msgId()) => ({
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  });

  /**
   * Move the conversation's rows back in time, in order, as if the user had
   * waited for each reply: admission refuses a message sent within
   * MIN_TURN_INTERVAL_MS of the previous one.
   */
  const settle = (conversationId: string) =>
    prisma.$executeRaw`
      UPDATE ai_conversation_messages SET created_at = created_at - interval '10 seconds'
      WHERE conversation_id = ${conversationId}`;

  const admit = async (conversationId: string, message: unknown) => {
    await settle(conversationId);
    return askMoji.admitUserMessage({ conversationId, message });
  };

  const reply = (text: string, id = `a:${randomUUID()}`, extra: unknown[] = []) =>
    ({
      id,
      role: 'assistant',
      parts: [{ type: 'step-start' }, ...extra, { type: 'text', text }],
    }) as never;

  const refusedCode = (r: { ok: boolean; code?: string }) => (r.ok ? undefined : r.code);

  // ─── session start ────────────────────────────────────────────────────────

  describe('create and reuse', () => {
    it('stores the grant with the contract version and a canonical zone', async () => {
      const id = await start(userA, classX, { browser_timezone: 'Not/AZone' });
      const row = await prisma.aIConversation.findUniqueOrThrow({ where: { id } });
      expect(row.type).toBe('SYLLABUS_BOT');
      expect(row.user_id).toBe(userA);
      expect(row.classroom_id).toBe(classX);
      const grant = (row.context as { grant: Record<string, unknown> }).grant;
      expect(grant.contract_version).toBe(CONTRACT_VERSION);
      expect(grant.browser_timezone).toBeNull();
    });

    it('reuses the latest matching conversation for the same user, classroom and view', async () => {
      const id = await start(userA, classX);
      const found = await askMoji.findActive({
        userId: userA,
        classroomId: classX,
        viewAs: 'STUDENT',
      });
      expect(found?.conversationId).toBe(id);
      // Another user, another classroom, another view: nothing.
      expect(
        await askMoji.findActive({ userId: userB, classroomId: classX, viewAs: 'STUDENT' })
      ).toBeNull();
      expect(
        await askMoji.findActive({ userId: userA, classroomId: classY, viewAs: 'STUDENT' })
      ).toBeNull();
      expect(
        await askMoji.findActive({ userId: userA, classroomId: classX, viewAs: 'ASSISTANT' })
      ).toBeNull();
      expect(
        await askMoji.findActive({ userId: userA, classroomId: classX, viewAs: 'student' })
      ).toBeNull();
    });

    it('never picks up a legacy row or an ended one; an old one stays open', async () => {
      await prisma.aIConversation.create({
        data: {
          type: 'SYLLABUS_BOT',
          user_id: userA,
          classroom_id: classX,
          context: { userRole: 'STUDENT' },
        },
      });
      const lookup = () =>
        askMoji.findActive({ userId: userA, classroomId: classX, viewAs: 'STUDENT' });
      expect(await lookup()).toBeNull();

      // No expiry: a conversation idle for weeks is still the one.
      const old = await start(userA, classX);
      await prisma.aIConversation.update({
        where: { id: old },
        data: { last_activity: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      });
      expect((await lookup())?.conversationId).toBe(old);

      await askMoji.end({ conversationId: old, userId: userA, classroomId: classX });
      expect(await lookup()).toBeNull();
    });

    it('does not reuse a conversation whose impersonation has ended', async () => {
      await start(userA, classX, {
        actor_user_id: ownerX,
        impersonation: {
          by: ownerX,
          session_id: 's',
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      expect(
        await askMoji.findActive({ userId: userA, classroomId: classX, viewAs: 'STUDENT' })
      ).toBeNull();
    });

    it("closes the user's older conversations for that classroom and view only", async () => {
      const legacy = await prisma.aIConversation.create({
        data: { type: 'SYLLABUS_BOT', user_id: userA, classroom_id: classX },
      });
      const older = await start(userA, classX);
      const otherClass = await start(userA, classY);
      const otherUser = await start(userB, classX);
      // taStudent holds ASSISTANT and STUDENT: an ASSISTANT view is another view.
      const taOlder = await start(taStudent, classX);
      const otherView = await start(taStudent, classX, {
        view_as: 'ASSISTANT',
        role_ceiling: null,
      });

      const result = await askMoji.create({ grant: grantFor(userA, classX) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.closedConversationIds).toEqual([older]);
      const taNew = await askMoji.create({ grant: grantFor(taStudent, classX) });
      expect(taNew.ok && taNew.closedConversationIds).toEqual([taOlder]);

      const statuses = await prisma.aIConversation.findMany({
        where: {
          id: { in: [legacy.id, older, otherClass, otherUser, otherView, result.conversationId] },
        },
        select: { id: true, status: true },
      });
      const statusOf = (id: string) => statuses.find(s => s.id === id)?.status;
      expect(statusOf(older)).toBe('COMPLETED');
      expect(statusOf(legacy.id)).toBe('ACTIVE');
      expect(statusOf(otherClass)).toBe('ACTIVE');
      expect(statusOf(otherUser)).toBe('ACTIVE');
      expect(statusOf(otherView)).toBe('ACTIVE');
      expect(statusOf(result.conversationId)).toBe('ACTIVE');
      expect(
        (await askMoji.findActive({ userId: taStudent, classroomId: classX, viewAs: 'ASSISTANT' }))
          ?.conversationId
      ).toBe(otherView);
    });

    it('rate limits starts per user, across classrooms', async () => {
      for (let n = 0; n < START_RATE_LIMIT.max; n++) {
        await start(userA, n % 2 ? classX : classY);
      }
      const refused = await askMoji.create({ grant: grantFor(userA, classX) });
      expect(refused).toEqual({ ok: false, code: 'RATE_LIMITED', permanent: false });
      // Another user is not affected.
      expect((await askMoji.create({ grant: grantFor(userB, classX) })).ok).toBe(true);
    });

    it('serializes concurrent starts: one conversation stays open', async () => {
      const results = await Promise.all(
        [0, 1, 2].map(() => askMoji.create({ grant: grantFor(userA, classX) }))
      );
      expect(results.every(r => r.ok)).toBe(true);
      const open = await prisma.aIConversation.count({
        where: { user_id: userA, classroom_id: classX, status: 'ACTIVE' },
      });
      expect(open).toBe(1);
    });
  });

  describe('findOwned and end', () => {
    it('gives one answer for missing, not yours, other classroom, other type and legacy', async () => {
      const id = await start(userA, classX);
      const owned = (conversationId: string, userId = userA, classroomId = classX) =>
        askMoji.findOwned({ conversationId, userId, classroomId });
      expect((await owned(id))?.conversationId).toBe(id);
      expect(await owned(id, userB)).toBeNull();
      expect(await owned(id, userA, classY)).toBeNull();
      expect(await owned(randomUUID())).toBeNull();
      expect(await owned('x'.repeat(500))).toBeNull();

      const quiz = await prisma.aIConversation.create({
        data: { type: 'QUIZ', user_id: userA, classroom_id: classX, context: { grant: {} } },
      });
      expect(await owned(quiz.id)).toBeNull();
      const legacy = await prisma.aIConversation.create({
        data: { type: 'SYLLABUS_BOT', user_id: userA, classroom_id: classX },
      });
      expect(await owned(legacy.id)).toBeNull();
    });

    it('ends only the owner’s conversation, once', async () => {
      const id = await start(userA, classX);
      expect(await askMoji.end({ conversationId: id, userId: userB, classroomId: classX })).toEqual(
        { owned: false, changed: false }
      );
      expect(await askMoji.end({ conversationId: id, userId: userA, classroomId: classY })).toEqual(
        { owned: false, changed: false }
      );
      expect(await askMoji.end({ conversationId: id, userId: userA, classroomId: classX })).toEqual(
        { owned: true, changed: true, hadSession: false }
      );
      expect(await askMoji.end({ conversationId: id, userId: userA, classroomId: classX })).toEqual(
        { owned: true, changed: false, hadSession: false }
      );
      expect(
        await askMoji.findOwned({ conversationId: id, userId: userA, classroomId: classX })
      ).toBeNull();
    });
  });

  // ─── admission ────────────────────────────────────────────────────────────

  describe('admitUserMessage', () => {
    it('admits a user message and counts the turn', async () => {
      const id = await start(userA, classX);
      const message = userMessage('When is the midterm?');
      const result = await admit(id, message);
      expect(result).toEqual({
        ok: true,
        status: 'admitted',
        messageId: message.id,
        role: 'STUDENT',
        turnsUsed: 1,
        metadata: {},
        viewing: null,
      });
      const row = await prisma.aIConversationMessage.findFirstOrThrow({
        where: { conversation_id: id, ui_message_id: message.id },
      });
      expect(row.role).toBe('USER');
      expect(row.parts).toEqual([{ type: 'text', text: 'When is the midterm?' }]);
      // Server-only: the acting role and the resolved viewing (none sent).
      expect(row.metadata).toEqual({ acting_role: 'STUDENT', resolved_viewing: null });
      expect(row.format).toBe('ui_message_v1');
      expect(row.contract_version).toBe(CONTRACT_VERSION);
    });

    it('refuses a quiz conversation, a legacy row and a missing id as NOT_FOUND, permanent', async () => {
      const quiz = await prisma.aIConversation.create({
        data: { type: 'QUIZ', user_id: userA, classroom_id: classX },
      });
      const legacy = await prisma.aIConversation.create({
        data: { type: 'SYLLABUS_BOT', user_id: userA, classroom_id: classX, context: {} },
      });
      for (const conversationId of [quiz.id, legacy.id, randomUUID()]) {
        expect(await admit(conversationId, userMessage('hi'))).toEqual({
          ok: false,
          code: 'NOT_FOUND',
          permanent: true,
        });
      }
      expect(
        await prisma.aIConversationMessage.count({ where: { conversation_id: legacy.id } })
      ).toBe(0);
    });

    it('refuses a grant that names another user or classroom (SESSION_ENDED)', async () => {
      const id = await start(userA, classX);
      // A grant copied onto another user's row does not hold for that row.
      await prisma.aIConversation.update({ where: { id }, data: { user_id: userB } });
      expect(refusedCode(await admit(id, userMessage('hi')))).toBe('SESSION_ENDED');
      await prisma.aIConversation.update({
        where: { id },
        data: { user_id: userA, classroom_id: classY },
      });
      expect(refusedCode(await admit(id, userMessage('hi')))).toBe('SESSION_ENDED');
    });

    it('refuses once the impersonation behind the grant has ended, for good', async () => {
      const id = await start(userA, classX, {
        actor_user_id: ownerX,
        impersonation: {
          by: ownerX,
          session_id: 's',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect((await admit(id, userMessage('first'))).ok).toBe(true);
      await prisma.$executeRaw`
        UPDATE ai_conversations
        SET context = jsonb_set(context, '{grant,impersonation,expires_at}', ${JSON.stringify(new Date(Date.now() - 1000).toISOString())}::jsonb)
        WHERE id = ${id}`;
      expect(await admit(id, userMessage('second'))).toEqual({
        ok: false,
        code: 'SESSION_ENDED',
        permanent: true,
      });
    });

    it('refuses an ended conversation (CONVERSATION_ENDED, permanent)', async () => {
      const id = await start(userA, classX);
      await askMoji.end({ conversationId: id, userId: userA, classroomId: classX });
      expect(await admit(id, userMessage('hi'))).toEqual({
        ok: false,
        code: 'CONVERSATION_ENDED',
        permanent: true,
      });
    });

    it('refuses a removed member mid-conversation (NOT_A_MEMBER, permanent)', async () => {
      const removed = await makeUser('removed');
      await join(classX, removed, 'STUDENT');
      const id = await start(removed, classX);
      expect((await admit(id, userMessage('first'))).ok).toBe(true);
      await prisma.classroomMembership.deleteMany({
        where: { user_id: removed, classroom_id: classX },
      });
      expect(await admit(id, userMessage('second'))).toEqual({
        ok: false,
        code: 'NOT_A_MEMBER',
        permanent: true,
      });
    });

    it('acts under the ceiling: a TA viewing as a student acts as STUDENT', async () => {
      const capped = await start(taStudent, classX, { role: 'ASSISTANT' });
      expect(await admit(capped, userMessage('hi'))).toMatchObject({ ok: true, role: 'STUDENT' });
      const uncapped = await askMoji.create({
        grant: grantFor(taStudent, classX, {
          role: 'ASSISTANT',
          view_as: 'ASSISTANT',
          role_ceiling: null,
        }),
      });
      expect(uncapped.ok).toBe(true);
      if (!uncapped.ok) return;
      expect(await admit(uncapped.conversationId, userMessage('hi'))).toMatchObject({
        ok: true,
        role: 'ASSISTANT',
      });
      const context = await askMoji.contextForTurn(capped);
      expect(context?.actingRole).toBe('STUDENT');
    });

    it('refuses for good once no role is left under the ceiling (NOT_ALLOWED)', async () => {
      const id = await start(userA, classX, { role_ceiling: 'STUDENT' });
      await prisma.classroomMembership.updateMany({
        where: { user_id: userA, classroom_id: classX },
        data: { role: 'TEACHER' },
      });
      try {
        expect(await admit(id, userMessage('hi'))).toEqual({
          ok: false,
          code: 'NOT_ALLOWED',
          permanent: true,
        });
      } finally {
        await prisma.classroomMembership.updateMany({
          where: { user_id: userA, classroom_id: classX },
          data: { role: 'STUDENT' },
        });
      }
    });

    it('applies the mutation rule: LOCKED refuses a student, not the owner', async () => {
      const student = await start(userA, classX);
      const owner = await start(ownerX, classX, {
        role: 'OWNER',
        view_as: 'OWNER',
        role_ceiling: 'OWNER',
      });
      await prisma.classroom.update({ where: { id: classX }, data: { status: 'LOCKED' } });
      try {
        expect(await admit(student, userMessage('hi'))).toEqual({
          ok: false,
          code: 'CLASSROOM_LOCKED',
          permanent: false,
        });
        expect((await admit(owner, userMessage('hi'))).ok).toBe(true);
        await prisma.classroom.update({ where: { id: classX }, data: { status: 'UNPUBLISHED' } });
        expect(refusedCode(await admit(student, userMessage('hi')))).toBe('CLASSROOM_UNPUBLISHED');
      } finally {
        await prisma.classroom.update({ where: { id: classX }, data: { status: 'ACTIVE' } });
      }
      // The refusals were transient: the conversation goes on.
      expect((await admit(student, userMessage('again'))).ok).toBe(true);
    });

    it('refuses while Pro has lapsed, and admits again once it is back (transient)', async () => {
      const id = await start(userA, classX);
      await prisma.subscription.updateMany({
        where: { user_id: ownerX },
        data: { ends_at: new Date(Date.now() - 1000) },
      });
      try {
        expect(await admit(id, userMessage('hi'))).toEqual({
          ok: false,
          code: 'UNAVAILABLE',
          permanent: false,
        });
      } finally {
        await prisma.subscription.updateMany({
          where: { user_id: ownerX },
          data: { ends_at: null },
        });
      }
      expect((await admit(id, userMessage('hi'))).ok).toBe(true);
    });

    it('refuses while the classroom has Ask Moji switched off (transient)', async () => {
      const id = await start(userA, classX);
      await prisma.classroomSettings.update({
        where: { classroom_id: classX },
        data: { syllabus_bot_enabled: false },
      });
      try {
        expect(await admit(id, userMessage('hi'))).toEqual({
          ok: false,
          code: 'NOT_ENABLED',
          permanent: false,
        });
      } finally {
        await prisma.classroomSettings.update({
          where: { classroom_id: classX },
          data: { syllabus_bot_enabled: true },
        });
      }
    });

    it('refuses a malformed message (INVALID_MESSAGE)', async () => {
      const id = await start(userA, classX);
      const bad = [
        null,
        'hi',
        { id: msgId(), role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
        { id: 'server:x', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { id: msgId(), role: 'user', parts: [] },
        { id: msgId(), role: 'user', parts: [{ type: 'text', text: '   ' }] },
        {
          id: msgId(),
          role: 'user',
          parts: [{ type: 'text', text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }],
        },
        {
          id: msgId(),
          role: 'user',
          parts: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
        { id: msgId(), role: 'user', parts: [{ type: 'file', url: 'https://x' }] },
      ];
      for (const message of bad) {
        expect(await admit(id, message)).toEqual({
          ok: false,
          code: 'INVALID_MESSAGE',
          permanent: false,
        });
      }
      expect(await prisma.aIConversationMessage.count({ where: { conversation_id: id } })).toBe(0);
    });

    it('paces new messages but not a re-delivery', async () => {
      const id = await start(userA, classX);
      const first = userMessage('one');
      expect((await askMoji.admitUserMessage({ conversationId: id, message: first })).ok).toBe(
        true
      );
      expect(
        await askMoji.admitUserMessage({ conversationId: id, message: userMessage('two') })
      ).toEqual({ ok: false, code: 'PACE', permanent: false });
      // The same message again (a recovery boot) is not a new turn.
      expect(await askMoji.admitUserMessage({ conversationId: id, message: first })).toMatchObject({
        ok: true,
        status: 'redelivered',
        turnsUsed: 1,
      });
    });

    it('re-delivers until a final reply exists, then skips', async () => {
      const id = await start(userA, classX);
      const message = userMessage('What is due?');
      await admit(id, message);
      expect(await admit(id, message)).toMatchObject({
        ok: true,
        status: 'redelivered',
        turnsUsed: 1,
      });

      // A partial reply (stopped) still re-runs.
      await askMoji.persistAssistantMessage({
        conversationId: id,
        message: reply('Half an ans', 'a:partial'),
        final: false,
      });
      expect(await admit(id, message)).toMatchObject({ status: 'redelivered' });

      await askMoji.persistAssistantMessage({ conversationId: id, message: reply('Lab 3.') });
      expect(await admit(id, message)).toMatchObject({ ok: true, status: 'already_answered' });
      // Same id with other text is refused; nothing is written.
      expect(
        refusedCode(await admit(id, { ...message, parts: [{ type: 'text', text: 'other' }] }))
      ).toBe('INVALID_MESSAGE');
      expect(
        await prisma.aIConversationMessage.count({ where: { conversation_id: id, role: 'USER' } })
      ).toBe(1);
    });

    it('skips a re-delivery of an older message', async () => {
      const id = await start(userA, classX);
      const older = userMessage('first');
      await admit(id, older);
      await admit(id, userMessage('second'));
      expect(await admit(id, older)).toMatchObject({ ok: true, status: 'already_answered' });
    });

    it("refuses one conversation's message id in another user's conversation by scope", async () => {
      const mine = await start(userA, classX);
      const theirs = await start(userB, classX);
      const message = userMessage('shared id');
      await admit(mine, message);
      // The same browser id in B's conversation is B's own new message.
      expect(await admit(theirs, message)).toMatchObject({ ok: true, status: 'admitted' });
      const rows = await prisma.aIConversationMessage.findMany({
        where: { ui_message_id: message.id },
        select: { conversation_id: true },
      });
      expect(rows.map(r => r.conversation_id).sort()).toEqual([mine, theirs].sort());
    });

    it('carries a valid `viewing` and refuses any other metadata', async () => {
      const id = await start(userA, classX);
      const viewing = { kind: 'assignment', id: 'asg_1' };
      const message = { ...userMessage('Is this due Friday?'), metadata: { viewing } };
      expect(await admit(id, message)).toMatchObject({
        ok: true,
        status: 'admitted',
        metadata: { viewing },
      });
      const row = await prisma.aIConversationMessage.findFirstOrThrow({
        where: { conversation_id: id, ui_message_id: message.id },
      });
      // Stored as sent, with the server-only keys beside it (an id from
      // nowhere resolves to nothing).
      expect(row.metadata).toEqual({ viewing, acting_role: 'STUDENT', resolved_viewing: null });
      // A re-delivery reports the stored client metadata only.
      expect(await admit(id, message)).toMatchObject({
        status: 'redelivered',
        metadata: { viewing },
      });
      for (const metadata of [
        { injected: true },
        { viewing: { kind: 'repo', id: 'x' } },
        { viewing: { kind: 'page', id: 'p', title: 'Grades' } },
        { viewing, hiddenPartIndexes: [0] },
        'viewing',
      ]) {
        expect(refusedCode(await admit(id, { ...userMessage('hi'), metadata }))).toBe(
          'INVALID_MESSAGE'
        );
      }
    });

    it('has no turn limit', async () => {
      const id = await start(userA, classX);
      await prisma.aIConversationMessage.createMany({
        data: Array.from({ length: 200 }, (_, n) => ({
          conversation_id: id,
          role: 'USER' as const,
          content: `q${n}`,
          parts: [{ type: 'text', text: `q${n}` }],
          format: 'ui_message_v1',
          ui_message_id: `seed${n}`,
          created_at: new Date(Date.now() - 60_000 + n),
        })),
      });
      expect(await admit(id, userMessage('one more'))).toMatchObject({
        ok: true,
        status: 'admitted',
        turnsUsed: 201,
      });
    });

    it('admits two messages raced on one conversation one at a time', async () => {
      const id = await start(userA, classX);
      const results = await Promise.all([
        askMoji.admitUserMessage({ conversationId: id, message: userMessage('a') }),
        askMoji.admitUserMessage({ conversationId: id, message: userMessage('b') }),
      ]);
      // The lock serializes them: the second is inside the pace window.
      expect(results.map(r => (r.ok ? 'ok' : r.code)).sort()).toEqual(['PACE', 'ok']);
    });
  });

  // ─── storage ──────────────────────────────────────────────────────────────

  describe('persistAssistantMessage', () => {
    it('stores the full parts server-side, and the transcript shows none of the MCP parts', async () => {
      const id = await start(userA, classX);
      await admit(id, userMessage('Who is behind?'));
      const parts = [
        { type: 'reasoning', text: 'thinking it over' },
        {
          type: 'tool-get_roster',
          toolCallId: 'call_1',
          state: 'output-available',
          input: {},
          output: { students: [{ name: 'Bo', email: 'b@x.test' }] },
        },
        {
          type: 'dynamic-tool',
          toolName: 'list_submissions',
          toolCallId: 'call_2',
          state: 'output-available',
          input: { q: 1 },
          output: { rows: ['submission rows'] },
        },
        { type: 'data-step', data: { title: 'Looking at the roster' } },
        { type: 'data-notice', data: { code: 'bogus' } },
        {
          type: 'tool-cite_content',
          toolCallId: 'call_3',
          state: 'output-available',
          input: { type: 'page', id: 'p1' },
          output: { ok: true, title: 'Syllabus', url: 'https://pages.test/p1' },
        },
      ];
      const message = reply('Bo is behind on Lab 2.', 'a:1', parts);
      expect(await askMoji.persistAssistantMessage({ conversationId: id, message })).toEqual({
        stored: true,
      });
      const row = await prisma.aIConversationMessage.findFirstOrThrow({
        where: { conversation_id: id, ui_message_id: 'a:1' },
      });
      expect(row.parts).toEqual((message as { parts: unknown[] }).parts);
      expect(row.content).toBe('Bo is behind on Lab 2.');
      expect(row.final).toBe(true);
      expect(row.provenance).toBe('model');
      expect(row.contract_version).toBe(CONTRACT_VERSION);

      // The model reads it all back.
      const history = await askMoji.loadModelHistory(id);
      expect(history[1].parts).toEqual((message as { parts: unknown[] }).parts);

      // The owner's transcript: no MCP calls, results or reasoning, and only
      // valid data parts.
      const transcript = await askMoji.loadTranscriptForViewer({
        conversationId: id,
        userId: userA,
        classroomId: classX,
      });
      expect(transcript?.[1].parts.map(p => p.type)).toEqual([
        'step-start',
        'data-step',
        'tool-cite_content',
        'text',
      ]);
      const shown = JSON.stringify(transcript);
      expect(shown).not.toContain('b@x.test');
      expect(shown).not.toContain('submission rows');
      expect(shown).not.toContain('thinking it over');
    });

    it('refuses once the conversation is no longer active, and never overwrites a final', async () => {
      const id = await start(userA, classX);
      await askMoji.persistAssistantMessage({ conversationId: id, message: reply('done', 'a:f') });
      expect(
        await askMoji.persistAssistantMessage({
          conversationId: id,
          message: reply('partial', 'a:f'),
          final: false,
        })
      ).toEqual({ stored: false });
      await askMoji.end({ conversationId: id, userId: userA, classroomId: classX });
      expect(
        await askMoji.persistAssistantMessage({ conversationId: id, message: reply('late') })
      ).toEqual({ stored: false });
      const quiz = await prisma.aIConversation.create({
        data: { type: 'QUIZ', user_id: userA, classroom_id: classX },
      });
      expect(
        await askMoji.persistAssistantMessage({ conversationId: quiz.id, message: reply('x') })
      ).toEqual({ stored: false });
    });

    it('moves last_activity', async () => {
      const id = await start(userA, classX);
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await prisma.aIConversation.update({ where: { id }, data: { last_activity: past } });
      await askMoji.persistAssistantMessage({ conversationId: id, message: reply('x') });
      const row = await prisma.aIConversation.findUniqueOrThrow({ where: { id } });
      expect(row.last_activity.getTime()).toBeGreaterThan(past.getTime());
    });
  });

  describe('loadModelHistory', () => {
    it('keeps final replies in full, and drops user rows that never got a final reply', async () => {
      const id = await start(userA, classX);
      const answered = userMessage('Q1');
      await admit(id, answered);
      await askMoji.persistAssistantMessage({
        conversationId: id,
        message: reply('A1', 'a:1', [
          { type: 'tool-content_search', toolCallId: 't', state: 'output-available', output: {} },
          { type: 'step-start' },
          {
            type: 'tool-cite_content',
            toolCallId: 'c',
            state: 'output-available',
            input: { type: 'page', id: 'p' },
            output: { ok: true, title: 'P' },
          },
          { type: 'data-step', data: { title: 'Searching' } },
        ]),
      });
      const failed = userMessage('Q2 (failed)');
      await admit(id, failed);
      const stopped = userMessage('Q3 (stopped)');
      await admit(id, stopped);
      await askMoji.persistAssistantMessage({
        conversationId: id,
        message: reply('half', 'a:3'),
        final: false,
      });
      const current = userMessage('Q4');
      await admit(id, current);

      const history = await askMoji.loadModelHistory(id);
      expect(history.map(m => [m.role, m.id])).toEqual([
        ['user', answered.id],
        ['assistant', 'a:1'],
        ['user', current.id],
      ]);
      expect(history[1].parts.map(p => p.type)).toEqual([
        'step-start',
        'tool-content_search',
        'step-start',
        'tool-cite_content',
        'data-step',
        'text',
      ]);
      expect(history[0].parts).toEqual([{ type: 'text', text: 'Q1' }]);

      // Re-running the stopped turn keeps it (and only it) as the one being answered.
      const rerun = await askMoji.loadModelHistory(id, { answeringMessageId: stopped.id });
      expect(rerun.map(m => m.id)).toEqual([answered.id, 'a:1', stopped.id]);
    });
  });

  describe('reads and runtime state', () => {
    it('reads a transcript for its owner only', async () => {
      const id = await start(userA, classX);
      await admit(id, userMessage('hi'));
      const read = (userId: string, classroomId: string) =>
        askMoji.loadTranscriptForViewer({ conversationId: id, userId, classroomId });
      expect(await read(userA, classX)).toHaveLength(1);
      expect(await read(userB, classX)).toBeNull();
      expect(await read(userA, classY)).toBeNull();
    });

    it('writes context.runtime without touching the grant, for Ask Moji rows only', async () => {
      const id = await start(userA, classX);
      expect(await askMoji.readRuntimeState(id)).toBeNull();
      expect(await askMoji.writeRuntimeState(id, { cursors: { out: 3 }, state: { s: 1 } })).toBe(
        true
      );
      expect(await askMoji.readRuntimeState(id)).toEqual({ cursors: { out: 3 }, state: { s: 1 } });
      const row = await prisma.aIConversation.findUniqueOrThrow({ where: { id } });
      expect(
        (row.context as { grant: { effective_user_id: string } }).grant.effective_user_id
      ).toBe(userA);
      expect(
        await askMoji.findOwned({ conversationId: id, userId: userA, classroomId: classX })
      ).not.toBeNull();

      const quiz = await prisma.aIConversation.create({
        data: { type: 'QUIZ', user_id: userA, classroom_id: classX },
      });
      expect(await askMoji.writeRuntimeState(quiz.id, { cursors: 1, state: 1 })).toBe(false);
      expect(await askMoji.readRuntimeState(quiz.id)).toBeNull();
    });

    it("re-derives the turn's context from the conversation's classroom", async () => {
      const id = await start(userA, classX, { browser_timezone: 'Europe/Paris' });
      const context = await askMoji.contextForTurn(id);
      expect(context).toMatchObject({
        userId: userA,
        classroomId: classX,
        classroomRef: `amoji-org-${suite}/amoji-${suite}-x`,
        timeZone: { timeZone: 'Europe/Paris', source: 'caller' },
        browserTimeZone: 'Europe/Paris',
        viewAs: 'STUDENT',
        roleCeiling: 'STUDENT',
        actingRole: 'STUDENT',
        hasClassroomKey: false,
        settings: { anthropic_api_key: null },
      });
      await prisma.classroomSettings.update({
        where: { classroom_id: classX },
        data: {
          timezone: 'America/Chicago',
          anthropic_api_key: ' sk-test ',
          syllabus_bot_model: 'm',
        },
      });
      try {
        expect(await askMoji.contextForTurn(id)).toMatchObject({
          timeZone: { timeZone: 'America/Chicago', source: 'classroom' },
          hasClassroomKey: true,
          settings: { anthropic_api_key: 'sk-test', syllabus_bot_model: 'm' },
        });
      } finally {
        await prisma.classroomSettings.update({
          where: { classroom_id: classX },
          data: { timezone: null, anthropic_api_key: null, syllabus_bot_model: null },
        });
      }
      const legacy = await prisma.aIConversation.create({
        data: { type: 'SYLLABUS_BOT', user_id: userA, classroom_id: classX },
      });
      expect(await askMoji.contextForTurn(legacy.id)).toBeNull();
    });
  });
});
