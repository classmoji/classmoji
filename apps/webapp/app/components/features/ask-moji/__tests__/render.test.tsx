// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import AskMojiMarkdown from '../AskMojiMarkdown';
import AskMojiMessageView from '../AskMojiMessage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chips = { classroomSlug: 'cs1', pagesUrl: 'https://pages.test', slidesUrl: null };

describe('Markdown', () => {
  it('renders GFM tables inside a sideways-scrolling wrapper', () => {
    const html = renderToStaticMarkup(
      <AskMojiMarkdown text={'| Week | Topic |\n| --- | --- |\n| 1 | Intro |\n| 2 | Git |'} />
    );
    expect(html).toContain('<div class="moji-table-wrap"><table>');
    expect(html).toContain('<th>Week</th>');
    expect(html).toContain('<td>Git</td>');
  });

  it('neutralises links that go nowhere and keeps real ones', () => {
    const html = renderToStaticMarkup(
      <AskMojiMarkdown
        text={
          '[Syllabus](content://page/1) [Top](#) [Docs](https://classmoji.io/docs) ![Logo](https://img.test/a.png)'
        }
      />
    );
    expect(html).not.toContain('content://');
    expect(html).not.toContain('href="#"');
    expect(html).toContain('<span>Syllabus</span>');
    expect(html).toContain(
      'href="https://classmoji.io/docs" target="_blank" rel="noopener noreferrer"'
    );
    // Images render as they always have.
    expect(html).toContain('<img src="https://img.test/a.png" alt="Logo"');
  });

  it('gives each code block its own Copy, and highlights it', () => {
    const html = renderToStaticMarkup(
      <AskMojiMarkdown text={'```js\nconst a = 1;\n```\n\n```py\nprint(1)\n```'} />
    );
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(2);
    expect(html).toContain('hljs');
  });
});

describe('an answer', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const answer: AskMojiUIMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'data-step', id: 'c1', data: { title: 'Searching course content', status: 'done' } },
      { type: 'data-step', id: 'c2', data: { title: 'Reading Syllabus', status: 'done' } },
      { type: 'text', text: 'The late policy is **24 hours**.' },
    ],
  } as AskMojiUIMessage;

  it('thumbs are pressed buttons that toggle and clear', () => {
    const onRate = vi.fn();
    act(() =>
      root.render(
        <AskMojiMessageView
          message={answer}
          live={false}
          rateable
          rating="UP"
          onRate={onRate}
          chips={chips}
        />
      )
    );
    const up = container.querySelector('[aria-label="Helpful"]') as HTMLButtonElement;
    const down = container.querySelector('[aria-label="Not helpful"]') as HTMLButtonElement;
    expect(up.getAttribute('aria-pressed')).toBe('true');
    expect(down.getAttribute('aria-pressed')).toBe('false');
    act(() => up.click());
    expect(onRate).toHaveBeenLastCalledWith('a1', null);
    act(() => down.click());
    expect(onRate).toHaveBeenLastCalledWith('a1', 'DOWN');
  });

  it('folds finished steps into one line; live steps show one by one; no actions while live', () => {
    act(() =>
      root.render(
        <AskMojiMessageView
          message={answer}
          live={false}
          rateable={false}
          rating={null}
          onRate={vi.fn()}
          chips={chips}
        />
      )
    );
    expect(container.textContent).toContain('Looked at 2 things');
    expect(container.textContent).not.toContain('Reading Syllabus');
    expect(container.querySelector('[aria-label="Copy answer"]')).not.toBeNull();

    act(() =>
      root.render(
        <AskMojiMessageView
          message={answer}
          live
          rateable={false}
          rating={null}
          onRate={vi.fn()}
          chips={chips}
        />
      )
    );
    expect(container.textContent).toContain('Reading Syllabus');
    expect(container.textContent).not.toContain('Looked at');
    expect(container.querySelector('[aria-label="Helpful"]')).toBeNull();
  });

  it('no thumbs on an answer that is not rateable (a partial reply, a live one); Copy stays', () => {
    act(() =>
      root.render(
        <AskMojiMessageView
          message={answer}
          live={false}
          rateable={false}
          rating="UP"
          onRate={vi.fn()}
          chips={chips}
        />
      )
    );
    expect(container.querySelector('[aria-label="Helpful"]')).toBeNull();
    expect(container.querySelector('[aria-label="Not helpful"]')).toBeNull();
    expect(container.querySelector('[aria-label="Copy answer"]')).not.toBeNull();
  });

  it('Copy copies the answer’s Markdown and says Copied', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() =>
      root.render(
        <AskMojiMessageView
          message={answer}
          live={false}
          rateable={false}
          rating={null}
          onRate={vi.fn()}
          chips={chips}
        />
      )
    );
    const copy = container.querySelector('[aria-label="Copy answer"]') as HTMLButtonElement;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith('The late policy is **24 hours**.');
    expect(container.querySelector('[aria-label="Copied"]')).not.toBeNull();
  });
});
