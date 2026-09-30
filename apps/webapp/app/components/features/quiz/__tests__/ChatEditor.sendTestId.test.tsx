/**
 * ChatEditor's optional `sendButtonTestId` lands on the real Send button (an
 * antd Button), and without it the button carries no test id, which is the
 * legacy chat's markup. The editor itself is stubbed: this is about the button.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  EditorContent: () => <div className="tiptap ProseMirror" />,
}));

const { default: ChatEditor } = await import('~/routes/student.$class.quizzes/ChatEditor');

describe('ChatEditor send button test id', () => {
  it('puts the given test id on the Send button', () => {
    const html = renderToStaticMarkup(
      <ChatEditor onSubmit={() => {}} sendButtonTestId="quiz-send" />
    );
    expect(html).toMatch(/<button[^>]*data-testid="quiz-send"[^>]*>(?:(?!<\/button>).)*Send/);
  });

  it('adds no test id when none is given', () => {
    const html = renderToStaticMarkup(<ChatEditor onSubmit={() => {}} />);
    expect(html).not.toContain('data-testid');
  });
});
