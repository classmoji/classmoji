// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const panelProps: Record<string, unknown>[] = [];
vi.mock('../AskMojiPanel', () => ({
  default: (props: Record<string, unknown>) => {
    panelProps.push(props);
    return <div data-testid="panel" data-open={String(props.open)} />;
  },
}));
vi.mock('../AskMojiProvider', () => ({
  AskMojiProvider: ({ children }: { children: unknown }) => children,
}));
const revalidate = vi.fn();
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate }) }));

const { default: AskMojiEmbed } = await import('../AskMojiEmbed');

const PAGES = 'https://pages.classmoji.io';
let container: HTMLDivElement;
let root: Root;
let parent: { postMessage: ReturnType<typeof vi.fn> };
let order: string[];

const ready = {
  state: 'ready' as const,
  parentOrigin: PAGES,
  classroomSlug: 'cs1',
  courseName: 'CS 1',
  pagesUrl: PAGES,
  slidesUrl: null,
  impersonated: false,
};

const hostSays = (data: unknown, origin = PAGES, source: unknown = parent) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));
  });

beforeEach(() => {
  panelProps.length = 0;
  order = [];
  parent = { postMessage: vi.fn(() => order.push('post')) };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, ...rest) => {
    if (type === 'message') order.push('listen');
    return add(type, ...(rest as [EventListener]));
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const lastPanel = () => panelProps.at(-1)!;

describe('the embed', () => {
  it('installs its listener, then posts ready to the checked parent origin only', () => {
    act(() => root.render(<AskMojiEmbed data={ready} />));
    expect(order.slice(0, 2)).toEqual(['listen', 'post']);
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'askmoji:ready' }, PAGES);
  });

  it('opens, closes and takes viewing only from the parent origin and window', () => {
    act(() => root.render(<AskMojiEmbed data={ready} />));
    expect(lastPanel().open).toBe(false);
    hostSays({ type: 'askmoji:open' }, 'https://evil.example');
    hostSays({ type: 'askmoji:open' }, PAGES, { not: 'the parent' });
    expect(lastPanel().open).toBe(false);
    hostSays({ type: 'askmoji:open' });
    expect(lastPanel().open).toBe(true);
    hostSays({ type: 'askmoji:viewing', viewing: { kind: 'page', id: 'p1' } });
    expect(lastPanel().viewing).toEqual({ kind: 'page', id: 'p1' });
    hostSays({ type: 'askmoji:viewing', viewing: { kind: 'grades', id: 'x' } });
    expect(lastPanel().viewing).toEqual({ kind: 'page', id: 'p1' });
    hostSays({ type: 'askmoji:close' });
    expect(lastPanel().open).toBe(false);
  });

  it('the host’s title labels the chip only; a bad one is dropped, the viewing kept', () => {
    act(() => root.render(<AskMojiEmbed data={ready} />));
    hostSays({
      type: 'askmoji:viewing',
      viewing: { kind: 'deck', id: 'd1', slide: 2 },
      title: 'Lecture 3',
    });
    expect(lastPanel().viewing).toEqual({ kind: 'deck', id: 'd1', slide: 2, title: 'Lecture 3' });
    hostSays({
      type: 'askmoji:viewing',
      viewing: { kind: 'page', id: 'p1' },
      title: 'x'.repeat(201),
    });
    expect(lastPanel().viewing).toEqual({ kind: 'page', id: 'p1' });
  });

  it('an impersonated session shows the fixed notice; a normal one none', () => {
    act(() => root.render(<AskMojiEmbed data={ready} />));
    expect(lastPanel().notice).toBeNull();
    act(() => root.render(<AskMojiEmbed data={{ ...ready, impersonated: true }} />));
    expect(lastPanel().notice).toBe('You are viewing as another user.');
  });

  it('asks the host to close, and reports busy changes once each', () => {
    act(() => root.render(<AskMojiEmbed data={ready} />));
    act(() => (lastPanel().onRequestClose as () => void)());
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'askmoji:request-close' }, PAGES);
    const onBusy = lastPanel().onBusyChange as (b: boolean) => void;
    act(() => {
      onBusy(true);
      onBusy(true);
      onBusy(false);
    });
    const busy = parent.postMessage.mock.calls.filter(c => c[0].type === 'askmoji:busy');
    expect(busy).toEqual([
      [{ type: 'askmoji:busy', busy: true }, PAGES],
      [{ type: 'askmoji:busy', busy: false }, PAGES],
    ]);
  });

  it('a framed embed with no verified parent origin talks to nobody and shows no chat', () => {
    act(() => root.render(<AskMojiEmbed data={{ ...ready, parentOrigin: null }} />));
    expect(parent.postMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
    expect(container.querySelector('[aria-label="Close Ask Moji"]')).not.toBeNull();
  });

  it('signed out: a sign-in link and a close control; opening again looks again', () => {
    act(() =>
      root.render(
        <AskMojiEmbed
          data={{ state: 'signed-out', parentOrigin: PAGES, signInUrl: 'https://classmoji.io/' }}
        />
      )
    );
    const link = container.querySelector('a[href="https://classmoji.io/"]') as HTMLAnchorElement;
    expect(link.target).toBe('_blank');
    const close = container.querySelector('[aria-label="Close Ask Moji"]') as HTMLButtonElement;
    act(() => close.click());
    expect(parent.postMessage).toHaveBeenLastCalledWith({ type: 'askmoji:request-close' }, PAGES);
    hostSays({ type: 'askmoji:open' });
    expect(revalidate).toHaveBeenCalled();
  });

  it('unavailable: the line and a close control', () => {
    act(() =>
      root.render(
        <AskMojiEmbed
          data={{ state: 'unavailable', parentOrigin: PAGES, line: 'Not here', staffLine: null }}
        />
      )
    );
    expect(container.textContent).toContain('Not here');
    expect(container.querySelector('[aria-label="Close Ask Moji"]')).not.toBeNull();
  });
});
