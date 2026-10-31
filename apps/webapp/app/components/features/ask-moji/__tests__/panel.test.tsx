// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';
import AskMojiPanel from '../AskMojiPanel';
import { AskMojiContext } from '../AskMojiProvider';
import { AskMojiController } from '../controller';
import {
  FakeTransport,
  answerMsg,
  fakeApi,
  openedFor,
  pushable,
  reply,
  stateOf,
  streamOf,
  userMsg,
} from './fakes';

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
    // The chip's title (a host's, a route's) never goes on the message.
    expect(transport.sends[0].messages.at(-1)!.metadata).toEqual({
      viewing: { kind: 'page', id: 'p1' },
    });
    expect(JSON.stringify(transport.sends[0])).not.toContain('Week 1');
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

  it('opening (and its auto-focus) boots no Trigger run; the first keystroke does, once', async () => {
    api.start.mockResolvedValue(openedFor('c1', { sessionReady: false }));
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea()));
    act(() => textarea().dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(transport.preload).not.toHaveBeenCalled();
    expect(api.ensureSession).not.toHaveBeenCalled();
    type('W');
    expect(transport.preload).toHaveBeenCalledTimes(1);
    expect(transport.preload).toHaveBeenCalledWith('c1');
    type('Wh');
    expect(transport.preload).toHaveBeenCalledTimes(1);
  });

  it('thumbs only on the server’s rateable answers, and never while a reply streams', async () => {
    const rated = { ...answerMsg('a0', 'Stored final'), metadata: { rateable: true } };
    const partial = { ...answerMsg('a1', 'Stored partial'), metadata: { rateable: false } };
    api.start.mockResolvedValue(
      openedFor('c1', {
        transcript: [userMsg('u0', 'Q0'), rated, userMsg('u1', 'Q1'), partial],
        state: { status: 'ACTIVE', lastMessageId: 'a1', inFlight: false },
      })
    );
    render(true);
    await vi.waitFor(() => expect(container.textContent).toContain('Stored partial'));
    const thumbs = () => container.querySelectorAll('[aria-label="Helpful"]').length;
    expect(thumbs()).toBe(1);

    const live = pushable();
    transport.sendQueue.push(() => live.stream);
    type('Q2');
    await act(async () => key('Enter'));
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    live.push(
      { type: 'start', messageId: 'a2' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Streaming' }
    );
    await vi.waitFor(() => expect(container.textContent).toContain('Streaming'));
    expect(thumbs()).toBe(0);

    // The stream ends; until the server's transcript marks it, the new answer has none.
    const userId = controller.getSnapshot().chat!.messages.at(-2)!.id;
    api.state.mockResolvedValue(
      stateOf({
        lastMessageId: 'a2',
        transcript: [
          userMsg('u0', 'Q0'),
          rated,
          userMsg('u1', 'Q1'),
          partial,
          userMsg(userId, 'Q2'),
          { ...answerMsg('a2', 'Streaming done'), metadata: { rateable: true } },
        ],
      })
    );
    await act(async () => {
      live.push({ type: 'text-end', id: 't' }, { type: 'finish' });
      live.close();
    });
    await vi.waitFor(() => expect(container.textContent).toContain('Streaming done'));
    expect(thumbs()).toBe(2);
  });

  it('a suggestion keeps the chip’s state, and a dismissed chip comes back after it is sent', async () => {
    render(true, { kind: 'page', id: 'p1', title: 'Week 1' });
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    act(() =>
      (
        container.querySelector(
          '[aria-label="Leave this out of the next question"]'
        ) as HTMLButtonElement
      ).click()
    );
    transport.sendQueue.push(() => streamOf(reply('a1', 'ok')));
    const suggestion = [...container.querySelectorAll('.moji-hint')].find(b =>
      b.textContent?.includes('What is due?')
    ) as HTMLButtonElement;
    await act(async () => suggestion.click());
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(transport.sends[0].messages.at(-1)!.metadata).toBeUndefined();
    await vi.waitFor(() => expect(container.textContent).toContain('Viewing: Week 1'));
  });

  it('a notice shows under the header', async () => {
    act(() =>
      root.render(
        <AskMojiContext.Provider value={controller}>
          <AskMojiPanel
            mode="embed"
            open
            onRequestClose={onRequestClose}
            courseName="CS 1"
            classroomSlug="cs1"
            pagesUrl={null}
            slidesUrl={null}
            viewing={null}
            notice="You are viewing as another user."
          />
        </AskMojiContext.Provider>
      )
    );
    expect(container.querySelector('.moji-notice')!.textContent).toBe(
      'You are viewing as another user.'
    );
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    expect(container.querySelector('.moji-notice')!.textContent).toBe(
      'You are viewing as another user.'
    );
  });

  it('a suggestion with the chip shown carries the viewing', async () => {
    render(true, { kind: 'page', id: 'p1', title: 'Week 1' });
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    transport.sendQueue.push(() => streamOf(reply('a1', 'ok')));
    const suggestion = container.querySelector('.moji-hint') as HTMLButtonElement;
    await act(async () => suggestion.click());
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(transport.sends[0].messages.at(-1)!.metadata).toEqual({
      viewing: { kind: 'page', id: 'p1' },
    });
  });

  it('the length is announced at 90% and at the limit, not on every keystroke', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    const announced = () =>
      container.querySelector('[data-testid="moji-counter-announce"]')!.textContent;
    const visible = container.querySelector('.moji-composer')!;
    type('x'.repeat(3599));
    expect(announced()).toBe('');
    type('x'.repeat(3600));
    expect(announced()).toBe('3,600 of 4,000 characters');
    type('x'.repeat(3750));
    expect(announced()).toBe('3,600 of 4,000 characters');
    type('x'.repeat(4000));
    expect(announced()).toBe('4,000 character limit reached');
    type('x'.repeat(4001));
    expect(announced()).toBe('Over the 4,000 character limit');
    // The visible counter is not a live region.
    expect(visible.querySelector('.moji-counter')!.getAttribute('aria-live')).toBeNull();
  });

  it('Enter while an answer streams says why instead of nothing', async () => {
    render(true);
    await vi.waitFor(() => expect(textarea().disabled).toBe(false));
    const live = pushable();
    transport.sendQueue.push(() => live.stream);
    type('First');
    await act(async () => key('Enter'));
    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    type('Second');
    await act(async () => key('Enter'));
    expect(container.textContent).toContain(ASK_MOJI_COPY.PACE);
    expect(textarea().value).toBe('Second');
    act(() => {
      live.push(...reply('a1', 'done'));
      live.close();
    });
  });
});
