import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The syllabus bot's tier decision.
 *
 * The property that matters is NOT "does it say Pro sometimes" — it is that it
 * delegates to `getProStateForClassroomId`, the one function that owns what
 * "Pro" means. An earlier revision of this module reimplemented the rules on
 * top of the superseded `getByClassroom`, which picks an arbitrary owner and
 * skips the accepted-invite filter. That made the bot disagree with quizzes on
 * multi-owner classrooms. These tests pin the delegation so it cannot come
 * back.
 */

const getProStateForClassroomIdMock = vi.fn();
const findUniqueConversationMock = vi.fn();
const findUniqueSettingsMock = vi.fn();

vi.mock('../subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => getProStateForClassroomIdMock(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    aIConversation: { findUnique: (...a: unknown[]) => findUniqueConversationMock(...a) },
    classroomSettings: { findUnique: (...a: unknown[]) => findUniqueSettingsMock(...a) },
  }),
}));

const CLASSROOM_ID = 'classroom-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('canUseSyllabusBot', () => {
  it('allows when the canonical resolver says the classroom is Pro', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true, tier: 'PRO', isActive: true });
    const { canUseSyllabusBot } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBot(CLASSROOM_ID)).toEqual({ allowed: true });
  });

  it('denies with pro_required when the resolver says it is not Pro', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: false, tier: 'FREE', isActive: true });
    const { canUseSyllabusBot } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBot(CLASSROOM_ID)).toEqual({
      allowed: false,
      reason: 'pro_required',
    });
  });

  it('delegates rather than reimplementing — asks the canonical resolver, by id', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    const { canUseSyllabusBot } = await import('../entitlement.service.ts');

    await canUseSyllabusBot(CLASSROOM_ID);

    expect(getProStateForClassroomIdMock).toHaveBeenCalledTimes(1);
    expect(getProStateForClassroomIdMock).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it("trusts isPro alone — a lapsed PRO row is the resolver's call, not ours", async () => {
    // tier says PRO but the plan has ended. The resolver already folded ends_at
    // into isPro; re-deriving it here is exactly the drift this guards against.
    getProStateForClassroomIdMock.mockResolvedValue({
      isPro: false,
      tier: 'PRO',
      isActive: false,
    });
    const { canUseSyllabusBot } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBot(CLASSROOM_ID)).toEqual({
      allowed: false,
      reason: 'pro_required',
    });
  });

  it('allows a multi-owner classroom the resolver rules Pro', async () => {
    // The regression case: getByClassroom would ask memberships[0] and could
    // answer FREE here while quizzes answered PRO.
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true, tier: 'PRO', isActive: true });
    const { canUseSyllabusBot } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBot(CLASSROOM_ID)).toEqual({ allowed: true });
  });
});

// The settings switch's answer must match the one the quiz routes serve by
// (assertProTier → getProStateForClassroomId), so it delegates the same way.
describe('canUseQuizzes', () => {
  it('allows when the canonical resolver says the classroom is Pro', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true, tier: 'PRO', isActive: true });
    const { canUseQuizzes } = await import('../entitlement.service.ts');

    expect(await canUseQuizzes(CLASSROOM_ID)).toEqual({ allowed: true });
    expect(getProStateForClassroomIdMock).toHaveBeenCalledTimes(1);
    expect(getProStateForClassroomIdMock).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it('denies with pro_required when the resolver says it is not Pro', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: false, tier: 'FREE', isActive: true });
    const { canUseQuizzes } = await import('../entitlement.service.ts');

    expect(await canUseQuizzes(CLASSROOM_ID)).toEqual({
      allowed: false,
      reason: 'pro_required',
    });
  });

  it('trusts isPro alone — a lapsed PRO row is denied', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({
      isPro: false,
      tier: 'PRO',
      isActive: false,
    });
    const { canUseQuizzes } = await import('../entitlement.service.ts');

    expect(await canUseQuizzes(CLASSROOM_ID)).toEqual({
      allowed: false,
      reason: 'pro_required',
    });
  });
});

describe('canUseSyllabusBotForConversation', () => {
  it('resolves the conversation to its classroom and gates on that', async () => {
    findUniqueConversationMock.mockResolvedValue({ classroom_id: CLASSROOM_ID });
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    const { canUseSyllabusBotForConversation } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBotForConversation('conv-1')).toEqual({ allowed: true });
    expect(getProStateForClassroomIdMock).toHaveBeenCalledWith(CLASSROOM_ID);
  });

  it('denies an unknown conversation as not_found, never as pro_required', async () => {
    findUniqueConversationMock.mockResolvedValue(null);
    const { canUseSyllabusBotForConversation } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBotForConversation('nope')).toEqual({
      allowed: false,
      reason: 'not_found',
    });
    expect(getProStateForClassroomIdMock).not.toHaveBeenCalled();
  });

  it('denies when the conversation resolves to a non-Pro classroom', async () => {
    findUniqueConversationMock.mockResolvedValue({ classroom_id: CLASSROOM_ID });
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: false });
    const { canUseSyllabusBotForConversation } = await import('../entitlement.service.ts');

    expect(await canUseSyllabusBotForConversation('conv-1')).toEqual({
      allowed: false,
      reason: 'pro_required',
    });
  });
});

describe('quizzesVisible', () => {
  it('is true on Pro with quizzes on, and with no settings row (the schema default is on)', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    const { quizzesVisible } = await import('../entitlement.service.ts');

    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: true });
    expect(await quizzesVisible(CLASSROOM_ID)).toBe(true);

    findUniqueSettingsMock.mockResolvedValue(null);
    expect(await quizzesVisible(CLASSROOM_ID)).toBe(true);
  });

  it('is false when the classroom is not Pro, even with quizzes switched on', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: false, tier: 'FREE' });
    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: true });
    const { quizzesVisible } = await import('../entitlement.service.ts');

    expect(await quizzesVisible(CLASSROOM_ID)).toBe(false);
  });

  it('is false on Pro when quizzes are switched off', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: false });
    const { quizzesVisible } = await import('../entitlement.service.ts');

    expect(await quizzesVisible(CLASSROOM_ID)).toBe(false);
  });

  it('asks the canonical resolver and reads only the switch, by classroom id', async () => {
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: true });
    const { quizzesVisible } = await import('../entitlement.service.ts');

    await quizzesVisible(CLASSROOM_ID);

    expect(getProStateForClassroomIdMock).toHaveBeenCalledWith(CLASSROOM_ID);
    expect(findUniqueSettingsMock).toHaveBeenCalledWith({
      where: { classroom_id: CLASSROOM_ID },
      select: { quizzes_enabled: true },
    });
  });
});

describe('quizzesVisibleOrThrow', () => {
  const env = { ...process.env };
  const configure = (on: boolean) => {
    if (on) {
      process.env.AI_AGENT_URL = 'http://localhost:6000';
      process.env.AI_AGENT_SHARED_SECRET = 'test-secret';
    } else {
      delete process.env.AI_AGENT_URL;
      delete process.env.AI_AGENT_SHARED_SECRET;
    }
  };

  afterEach(() => {
    process.env = { ...env };
  });

  it('is false without asking the database when the AI agent is not configured', async () => {
    configure(false);
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: true });
    const { quizzesVisibleOrThrow } = await import('../entitlement.service.ts');

    expect(await quizzesVisibleOrThrow(CLASSROOM_ID)).toBe(false);
    expect(getProStateForClassroomIdMock).not.toHaveBeenCalled();
    expect(findUniqueSettingsMock).not.toHaveBeenCalled();
  });

  it('needs both AI agent variables', async () => {
    configure(true);
    delete process.env.AI_AGENT_SHARED_SECRET;
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    const { quizzesVisibleOrThrow } = await import('../entitlement.service.ts');

    expect(await quizzesVisibleOrThrow(CLASSROOM_ID)).toBe(false);
  });

  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
  ])('with the agent configured, Pro=%s and switch=%s answer %s', async (isPro, on, expected) => {
    configure(true);
    getProStateForClassroomIdMock.mockResolvedValue({ isPro });
    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: on });
    const { quizzesVisibleOrThrow } = await import('../entitlement.service.ts');

    expect(await quizzesVisibleOrThrow(CLASSROOM_ID)).toBe(expected);
  });

  it('throws when the Pro lookup fails, never answers false', async () => {
    configure(true);
    const failure = new Error("Can't reach database server");
    getProStateForClassroomIdMock.mockRejectedValue(failure);
    findUniqueSettingsMock.mockResolvedValue({ quizzes_enabled: true });
    const { quizzesVisibleOrThrow } = await import('../entitlement.service.ts');

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).rejects.toBe(failure);
  });

  it('throws when the settings lookup fails', async () => {
    configure(true);
    const failure = new Error('settings read failed');
    getProStateForClassroomIdMock.mockResolvedValue({ isPro: true });
    findUniqueSettingsMock.mockRejectedValue(failure);
    const { quizzesVisibleOrThrow } = await import('../entitlement.service.ts');

    await expect(quizzesVisibleOrThrow(CLASSROOM_ID)).rejects.toBe(failure);
  });
});
