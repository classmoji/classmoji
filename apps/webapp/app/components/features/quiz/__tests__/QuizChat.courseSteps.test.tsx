// @vitest-environment jsdom
/**
 * Course-material lookups (content_get / content_search) render as the legacy
 * chat's did: a collapsed "Checked course material (N steps)" list with a book
 * icon, one line per lookup (the document's title, or the fixed label for a
 * search), and the activity line "Looking things up…" while only lookups have
 * happened. A reply that also read files keeps the code-analysis wording.
 * Both themes.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ messages: [], status: 'ready', sendMessage: vi.fn() }),
}));
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: () => ({}),
  useChatActions: () => ({ sendAction: vi.fn() }),
}));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// antd reads media queries; jsdom has none.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { QuizTranscript, activityLine, EXPLORING_LINE, LOOKING_UP_LINE, THINKING_LINE } =
  await import('../QuizChat');

const msg = (id: string, parts: unknown[]) =>
  ({ id, role: 'assistant', parts }) as unknown as QuizUIMessage;

const CARD = {
  preamble: 'Here is one.',
  total_questions: 5,
  question_text: 'What does nav mark up?',
};
const card = (n: number) => ({
  type: 'tool-present_question',
  toolCallId: `call-q${n}`,
  state: 'output-available',
  input: { ...CARD, question_number: n },
  output: { card: CARD, question_number: n, total_questions: 5 },
});
const lookup = (title?: string) => ({
  type: 'data-step',
  data: { kind: 'course_material', ...(title ? { title } : {}) },
});
const readFile = (path: string) => ({ type: 'data-step', data: { kind: 'read_file', path } });

const dom = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};
const saved = (parts: unknown[], isDarkMode: boolean) =>
  dom(
    renderToStaticMarkup(
      <QuizTranscript
        messages={[msg('a1', parts)]}
        status="ready"
        busy={false}
        isDarkMode={isDarkMode}
      />
    )
  );

describe('course-material steps on a saved reply', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`lists the lookups under the course-material header (${theme})`, () => {
      const root = saved([lookup('Semantic HTML'), lookup(), card(1)], theme === 'dark');
      const steps = root.querySelector<HTMLElement>('[data-testid="quiz-steps"]')!;

      expect(steps.textContent).toContain('Checked course material (2 steps)');
      expect(steps.textContent).not.toContain('Code Analysis');
      const lines = Array.from(steps.querySelectorAll('[data-step-kind="course_material"]'));
      expect(lines.map(line => line.textContent)).toEqual([
        'Semantic HTML',
        'Checking course material',
      ]);
      expect(steps.querySelectorAll('[aria-label="book"]').length).toBe(3);
      expect(steps.innerHTML).toContain(
        theme === 'dark' ? 'background-color:#111827' : 'background-color:#fafafa'
      );
    });
  }

  it('says one step for a single lookup', () => {
    const root = saved([lookup('Flexbox basics'), card(1)], false);
    expect(root.textContent).toContain('Checked course material (1 step)');
  });

  it('keeps the code-analysis header when the reply also read files', () => {
    const root = saved([readFile('src/App.tsx'), lookup('Semantic HTML'), card(1)], false);
    const steps = root.querySelector<HTMLElement>('[data-testid="quiz-steps"]')!;
    expect(steps.textContent).toContain('Code Analysis (2 steps)');
    expect(steps.textContent).toContain('src/App.tsx');
    expect(steps.textContent).toContain('Semantic HTML');
    expect(steps.textContent).not.toContain('Checked course material');
  });
});

describe('the activity line while material is looked up', () => {
  it('says "Looking things up…" while only lookups have happened', () => {
    expect(activityLine(msg('a1', []))).toBe(THINKING_LINE);
    expect(activityLine(msg('a1', [lookup()]))).toBe(LOOKING_UP_LINE);
    expect(activityLine(msg('a1', [lookup(), lookup('Semantic HTML')]))).toBe(LOOKING_UP_LINE);
    expect(activityLine(msg('a1', [lookup(), readFile('src/App.tsx')]))).toBe(EXPLORING_LINE);
    expect(activityLine(msg('a1', [lookup('Semantic HTML'), card(1)]))).toBeNull();
    expect(LOOKING_UP_LINE).toBe('Looking things up…');
  });

  describe('live', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    for (const theme of ['light', 'dark'] as const) {
      it(`shows the indicator and the open list until the card arrives (${theme})`, async () => {
        const render = async (parts: unknown[]) => {
          await act(async () => {
            root.render(
              <QuizTranscript
                messages={[msg('a1', parts)]}
                status="streaming"
                busy
                isDarkMode={theme === 'dark'}
              />
            );
          });
        };
        const typing = () => container.querySelector('[data-testid="quiz-typing"]');

        await render([lookup('Semantic HTML')]);
        expect(typing()?.textContent).toContain('Looking things up…');
        const steps = container.querySelector('[data-testid="quiz-steps"]')!;
        expect(steps.textContent).toContain('Checked course material (1 step)');
        expect(steps.querySelector('.ant-collapse-item-active')).not.toBeNull();

        await render([lookup('Semantic HTML'), card(1)]);
        expect(typing()).toBeNull();
        expect(steps.querySelector('.ant-collapse-item-active')).toBeNull();
      });
    }
  });
});
