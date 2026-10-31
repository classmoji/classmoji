/**
 * Pins `findInQuiz`, the one-attempt read behind the MCP get_quiz_attempt: an
 * attempt is found only together with its quiz id, so an attempt of another
 * quiz (in this classroom or any other) reads as none, and each login is the
 * username on the provider asked for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const attemptFindFirst = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({ quizAttempt: { findFirst: attemptFindFirst } }),
}));

const { findInQuiz } = await import('../quizAttempt.service.ts');

const account = (provider_id: string, username: string) => ({
  provider_id,
  username,
  email: null,
  image: null,
  gitlab_instance_id: '',
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findInQuiz', () => {
  it('looks the attempt up by its id AND its quiz id', async () => {
    attemptFindFirst.mockResolvedValue(null);

    expect(await findInQuiz('quiz-1', 'attempt-1', 'GITLAB')).toBeNull();
    expect(attemptFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'attempt-1', quiz_id: 'quiz-1' } })
    );
  });

  it('names the user by the provider asked for', async () => {
    attemptFindFirst.mockResolvedValue({
      id: 'attempt-1',
      quiz_id: 'quiz-1',
      user: {
        id: 'ada',
        name: 'Ada',
        accounts: [account('github', 'ada-gh'), account('gitlab', 'ada-gl')],
      },
    });

    const attempt = await findInQuiz('quiz-1', 'attempt-1', 'GITLAB');

    expect(attempt?.user).toMatchObject({ id: 'ada', login: 'ada-gl' });
    expect(attempt?.user).not.toHaveProperty('accounts');
  });
});
