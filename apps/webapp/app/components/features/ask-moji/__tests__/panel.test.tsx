// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';
import AskMojiPanel from '../AskMojiPanel';
import { AskMojiContext } from '../AskMojiProvider';
import { AskMojiController } from '../controller';
import { FakeTransport, fakeApi, openedFor, reply, stateOf, streamOf } from './fakes';

/** The panel mounted over a controller with a scripted transport and API. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof fakeApi>;
let transport: FakeTransport;
let controller: AskMojiController;
const onRequestClose = vi.fn();

const render = (
  open: boolean,
  viewing: { kind: 'page'; id: string; title: string } | null = null
) =>
  act(() =>
    root.render(
      <AskMojiContext.Provider value={controller}>
        <AskMojiPanel
          mode="embed"
          open={open}
          onRequestClose={onRequestClose}
          courseName="CS 1"
          classroomSlug="cs1"
          pagesUrl="https://pages.test"
          slidesUrl={null}
          viewing={viewing}
        />
      </AskMojiContext.Provider>
    )
  );

const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;

const type = (value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });

const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
  });

beforeEach(() => {
  window.sessionStorage.clear();
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  api = fakeApi();
  transport = new FakeTransport();
  controller = new AskMojiController({ api, transport, viewAs: null, pollMs: 1_000_000 });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onRequestClose.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the panel', () => {
  it('is a labelled dialog; closed it is hidden and starts nothing', () => {
    render(false);
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-label')).toBe('Ask Moji');
    expect(dialog.hidden).toBe(true);
    expect(api.start).not.toHaveBeenCalled();
  });

  it('opens on the welcome and suggestions, and focuses the composer', async () => {
    render(true);
    await vi.waitFor(() => expect(container.textContent).toContain('What is due?'));
    expect(container.textContent).toContain('Hi!');
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));
  });

  it('Enter sends with the viewing on the message; Shift+Enter does not; the draft clears', async () => {
    render(true, { kind: 'page', id: 'p1', title: 'Week 1' });
    await vi.waitFor(() => expect(textarea()).not.toBeNull());
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    expect(container.textContent).toContain('Viewing: Week 1');
    type('Hello\nthere');
    key('Enter', { shiftKey: true });
    expect(transport.sends).toHaveLength(0);
    expect(window.sessionStorage.getItem('classmoji:ask-moji:draft:c1')).toBe('Hello\nthere');
    transport.sendQueue.push(() => streamOf(reply('a1', 'Hi back')));
    await act(async () => {
      key('Enter');
    });
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(transport.sends[0].messages.at(-1)!.metadata).toEqual({
      viewing: { kind: 'page', id: 'p1' },
    });
    await vi.waitFor(() => expect(textarea().value).toBe(''));
    expect(window.sessionStorage.getItem('classmoji:ask-moji:draft:c1')).toBeNull();
    await vi.waitFor(() => expect(container.textContent).toContain('Hi back'));
  });

  it('a dismissed viewing chip leaves the viewing off the next message', async () => {
    render(true, { kind: 'page', id: 'p1', title: 'Week 1' });
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    const dismiss = container.querySelector(
      '[aria-label="Leave this out of the next question"]'
    ) as HTMLButtonElement;
    act(() => dismiss.click());
    expect(container.textContent).not.toContain('Viewing: Week 1');
    transport.sendQueue.push(() => streamOf(reply('a1', 'ok')));
    type('Q');
    await act(async () => key('Enter'));
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(transport.sends[0].messages.at(-1)!.metadata).toBeUndefined();
  });

  it('shows the counter near the limit and refuses an over-long question', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    type('x'.repeat(3600));
    expect(container.textContent).toContain('3,600 / 4,000');
    type('x'.repeat(4001));
    expect((container.querySelector('[aria-label="Send"]') as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('answering elsewhere: New conversation is disabled and the busy line shows', async () => {
    api.start.mockResolvedValue(
      openedFor('c1', { state: { status: 'ACTIVE', lastMessageId: 'u1', inFlight: true } })
    );
    transport.reconnectQueue.push(() => new ReadableStream());
    render(true);
    await vi.waitFor(() => expect(container.textContent).toContain(ASK_MOJI_COPY.BUSY_ELSEWHERE));
    expect(
      (container.querySelector('[aria-label="New conversation"]') as HTMLButtonElement).disabled
    ).toBe(true);
    expect(container.querySelector('.moji-body')!.getAttribute('aria-busy')).toBe('true');
  });

  it('Escape asks to close', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea()).not.toBeNull());
    key('Escape');
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('a question restored while the panel is closed does not collapse the composer', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    textarea().style.height = '20px';
    render(false);
    transport.sendQueue.push(() => streamOf([]));
    act(() => {
      // jsdom has no layout: a hidden element has no offsetParent, a shown one does.
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() {
          return this.closest('[hidden]') ? null : document.body;
        },
      });
    });
    await act(async () => {
      controller['set']({ restore: { text: 'Back again', nonce: 99 } });
    });
    expect(textarea().value).toBe('Back again');
    expect(textarea().style.height).toBe('20px');
    delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
  });

  it('typing clears a shown line', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    await act(async () => {
      controller['set']({ line: ASK_MOJI_COPY.SEND_FAILED });
    });
    expect(container.textContent).toContain(ASK_MOJI_COPY.SEND_FAILED);
    type('n');
    expect(container.textContent).not.toContain(ASK_MOJI_COPY.SEND_FAILED);
  });

  it('a REPLY_FAILED turn puts the question back in the composer', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    transport.sendQueue.push(() =>
      streamOf([
        { type: 'start', messageId: 'n1' },
        { type: 'data-notice', data: { code: 'REPLY_FAILED' } } as never,
        { type: 'finish' },
      ])
    );
    api.state.mockResolvedValueOnce(stateOf());
    api.state.mockResolvedValue(stateOf({ transcript: [] }));
    type('Lost question');
    await act(async () => key('Enter'));
    await vi.waitFor(() => expect(container.textContent).toContain(ASK_MOJI_COPY.REPLY_FAILED));
    await vi.waitFor(() => expect(textarea().value).toBe('Lost question'));
  });
});
