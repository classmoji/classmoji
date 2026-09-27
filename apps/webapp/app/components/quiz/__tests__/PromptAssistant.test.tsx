// @vitest-environment jsdom
/**
 * The prompt assistant panel's "New conversation" button, MOUNTED in jsdom
 * with fetch and EventSource stubbed. It replaces "Clear chat", which only
 * cleared the panel while the server kept (and replayed) the conversation: it
 * ends the session and starts a new one, and is disabled while a start, a
 * restart or a reply is pending. After a failed start it is the way forward,
 * while the composer waits for a session. The "Explore" banner doesn't restart
 * mid-turn either.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks', () => ({ useUser: () => ({ user: { login: 'tim' } }) }));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollTo = () => {};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PromptAssistant } = await import('../PromptAssistant');

const INIT_FAILED = "The prompt assistant couldn't start. Please try again.";
const REPO = 'https://github.com/cs52/example';

class FakeEventSource {
  static CLOSED = 2;
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

let releaseInit: () => void = () => {};
let initFails = false;
let endGate: Promise<void> | undefined;
let sessionCount = 0;

const fetchMock = vi.fn(async (_url: string, init: { body: FormData }) => {
  const action = init.body.get('_action');
  if (action === 'initSession') {
    sessionCount += 1;
    const sessionId = `s${sessionCount}`;
    // Held until the test releases it, so the pending state can be seen.
    await new Promise<void>(resolve => {
      releaseInit = resolve;
    });
    if (initFails) return { ok: false, status: 500, json: async () => ({ error: INIT_FAILED }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        sessionId,
        message: 'Welcome',
        hasCodeExploration: false,
      }),
    };
  }
  if (action === 'endSession') await endGate;
  return { ok: true, status: 200, json: async () => ({ success: true }) };
});

const actions = () => fetchMock.mock.calls.map(([, init]) => init.body.get('_action'));
/** Found by its accessible name. */
const button = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="New conversation"]');
const textarea = () => container.querySelector('textarea')!;
const explore = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent === 'Explore');
const errorLine = () => container.querySelector('.pa-error')?.textContent ?? null;

const renderPanel = (exampleRepoUrl?: string) =>
  act(async () =>
    root.render(
      <PromptAssistant
        classroomSlug="cs52"
        formContext={{ name: 'Closures quiz' }}
        exampleRepoUrl={exampleRepoUrl}
      />
    )
  );

/** Type into the composer and send, leaving the reply pending. */
const sendMessage = async (text: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(textarea(), text);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('.pa-send-btn')!.click());
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  sessionCount = 0;
  initFails = false;
  endGate = undefined;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await renderPanel();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('PromptAssistant — New conversation', () => {
  it('stands where "Clear chat" was, disabled while the session starts', async () => {
    expect(button()?.disabled).toBe(true);

    await act(async () => releaseInit());

    expect(button()).not.toBeNull();
    expect(button()?.disabled).toBe(false);
    // "Clear chat" was an unnamed button with a delete icon.
    expect(container.querySelector('.pa-header-actions [aria-label="delete"]')).toBeNull();
  });

  it('ends the session and starts a new one', async () => {
    await act(async () => releaseInit());

    await act(async () => button()!.click());
    expect(button()?.disabled).toBe(true);
    await act(async () => releaseInit());

    expect(actions()).toEqual(['initSession', 'endSession', 'initSession']);
    expect(fetchMock.mock.calls[1][1].body.get('sessionId')).toBe('s1');
    expect(button()?.disabled).toBe(false);
  });

  it('is disabled while a reply is pending', async () => {
    await act(async () => releaseInit());

    await sendMessage('Make a closures quiz');

    expect(actions()).toEqual(['initSession', 'sendMessage']);
    expect(button()?.disabled).toBe(true);
  });

  it('is disabled while the old session is still ending, so one click starts one', async () => {
    await act(async () => releaseInit());
    let releaseEnd!: () => void;
    endGate = new Promise<void>(resolve => {
      releaseEnd = resolve;
    });

    await act(async () => button()!.click());
    expect(button()?.disabled).toBe(true);
    await act(async () => button()!.click());

    await act(async () => releaseEnd());
    await act(async () => releaseInit());
    expect(actions()).toEqual(['initSession', 'endSession', 'initSession']);
  });

  it('offers a retry when the first start fails', async () => {
    initFails = true;
    await act(async () => releaseInit());

    expect(errorLine()).toBe(INIT_FAILED);
    expect(button()?.disabled).toBe(false);
    expect(textarea().disabled).toBe(true);
  });

  it('stays usable after a failed restart, while the composer waits for a session', async () => {
    await act(async () => releaseInit());
    initFails = true;
    await act(async () => button()!.click());
    await act(async () => releaseInit());

    expect(errorLine()).toBe(INIT_FAILED);
    expect(button()?.disabled).toBe(false);
    expect(textarea().disabled).toBe(true);

    initFails = false;
    await act(async () => button()!.click());
    await act(async () => releaseInit());

    expect(actions()).toEqual(['initSession', 'endSession', 'initSession', 'initSession']);
    expect(errorLine()).toBeNull();
    expect(textarea().disabled).toBe(false);
  });
});

describe('PromptAssistant — Explore', () => {
  it('is disabled while a reply is pending', async () => {
    await renderPanel(REPO);
    await act(async () => releaseInit());
    expect(explore()?.disabled).toBe(false);

    await sendMessage('Make a closures quiz');

    expect(explore()?.disabled).toBe(true);
    expect(actions()).toEqual(['initSession', 'sendMessage']);
  });
});
