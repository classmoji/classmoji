// @vitest-environment jsdom
/**
 * Starting a quiz that is not open now, from the student quiz list or the
 * dashboard's Up next (useStartQuiz), MOUNTED in jsdom.
 *
 * /api/quiz's restartQuiz answers a quiz that has not opened yet, or has
 * closed, with 403 and the service's own body ({ success: false, message,
 * reason }). The student sees that message in the "Cannot Start Quiz" dialog;
 * no start is sent and nothing navigates.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  revalidate: vi.fn(),
  modalError: vi.fn(),
  modalConfirm: vi.fn(),
}));

vi.mock('react-router', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/student/cs52/quizzes' }),
  useRevalidator: () => ({ revalidate: mocks.revalidate }),
}));
vi.mock('antd', () => ({
  Modal: { error: mocks.modalError, confirm: mocks.modalConfirm },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useStartQuiz } = await import('../useStartQuiz');

let api: ReturnType<typeof useStartQuiz>;
const Harness = () => {
  api = useStartQuiz('cs52');
  return null;
};

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('useStartQuiz — a quiz that is not open now', () => {
  it.each([
    ['quiz_not_open', 'Quiz is not open yet'],
    ['quiz_closed', 'Quiz is closed'],
  ])('%s: shows the service’s message and starts nothing', async (reason, message) => {
    fetchMock.mockResolvedValueOnce(json(403, { success: false, message, reason }));

    await act(async () => {
      await api.startQuiz('quiz-1');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      _action: 'restartQuiz',
      quizId: 'quiz-1',
    });
    expect(mocks.modalError).toHaveBeenCalledExactlyOnceWith({
      title: 'Cannot Start Quiz',
      content: message,
    });
    expect(mocks.modalConfirm).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('opens the attempt when the quiz is open', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true, attemptId: 'attempt-1' }))
      .mockResolvedValueOnce(json(200, { attemptId: 'attempt-1' }));

    await act(async () => {
      await api.startQuiz('quiz-1');
    });

    expect(mocks.modalError).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith('/student/cs52/quizzes/quiz-1/attempt/attempt-1');
  });
});
