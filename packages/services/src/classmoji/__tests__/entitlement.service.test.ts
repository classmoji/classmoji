import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../subscription.service.ts', () => ({
  getProStateForClassroomId: (...a: unknown[]) => getProStateForClassroomIdMock(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    aIConversation: { findUnique: (...a: unknown[]) => findUniqueConversationMock(...a) },
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
