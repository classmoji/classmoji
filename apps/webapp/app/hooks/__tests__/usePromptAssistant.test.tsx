// @vitest-environment jsdom
/**
 * The prompt assistant hook across a lost or closed stream, MOUNTED in jsdom
 * with fetch and EventSource stubbed.
 *
 * Replies only arrive over SSE, so:
 *   - a stream that has CLOSED shows the ended line and releases the composer;
 *   - a send once the stream has closed posts nothing (no reply could arrive),
 *     while one still connecting will do (the server replays what it missed);
 *   - the ended line (SSE or POST body) closes the stream, so it stops
 *     reconnecting and replaying;
 *   - a reply the stream replays on reconnect is shown once.
 * "New conversation" ends the session and opens a new one with the same form
 * context (the repo only when the session explored it), and unmounting ends
 * the session without waiting. A start that is superseded before it resolves
 * (by unmount or by another start) ends the session it opened, and a send's
 * outcome that lands after a new conversation began is ignored.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePromptAssistant } from '../usePromptAssistant';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDED = 'This conversation has ended. Start a new one to keep going.';
const GENERIC = 'Could not send your message. Please try again.';
const REPO = 'https://github.com/cs52/example';
const FORM_CONTEXT = { name: 'Closures quiz', subject: 'JavaScript' };

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  url: string;
  readyState = FakeEventSource.CONNECTING;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Deliver an event: a server-sent one carries `data`, a transport one none. */
  emit(type: string, data?: unknown) {
    const event =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach(listener => listener(event));
  }
}

const latestStream = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

let codeAware = false;
let sendReply: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { success: true, messageId: 'm-ack' },
};
let sessionCount = 0;

/** A request for this action waits here until the test releases it. */
const gates: Record<string, Promise<void> | undefined> = {};
const hold = (action: string) => {
  let release!: () => void;
  gates[action] = new Promise<void>(resolve => {
    release = resolve;
  });
  return () => {
    delete gates[action];
    release();
  };
};

const fetchMock = vi.fn(async (_url: string, init: { body: FormData }) => {
  const action = init.body.get('_action') as string;
  if (action === 'initSession') {
    sessionCount += 1;
    const sessionId = `s${sessionCount}`;
    await gates.initSession;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        sessionId,
        message: 'Welcome',
        hasCodeExploration: codeAware,
      }),
    };
  }
  if (action === 'sendMessage') {
    const { ok, status, body } = sendReply;
    await gates.sendMessage;
    return { ok, status, json: async () => body };
  }
  await gates[action];
  return { ok: true, status: 200, json: async () => ({ success: true }) };
});

/** The fields each POST carried, in order. */
const posts = () =>
  fetchMock.mock.calls.map(
    ([, init]) => Object.fromEntries(init.body.entries()) as Record<string, string>
  );

let hook: ReturnType<typeof usePromptAssistant>;
function Harness() {
  hook = usePromptAssistant({ classroomSlug: 'cs52' });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchMock);
  FakeEventSource.instances = [];
  fetchMock.mockClear();
  codeAware = false;
  sessionCount = 0;
  sendReply = { ok: true, status: 200, body: { success: true, messageId: 'm-ack' } };
  Object.keys(gates).forEach(action => delete gates[action]);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const init = async (repo: string | null = null) => {
  await act(async () => {
    await hook.initSession(FORM_CONTEXT, repo);
  });
};

const connect = () => act(() => latestStream().emit('connected', { sessionId: 's1' }));

const send = async (content: string) => {
  await act(async () => {
    await hook.sendMessage(content);
  });
};

/** Unmount now; afterEach unmounts again, so it gets a fresh root. */
const unmount = () => {
  act(() => root.unmount());
  root = createRoot(container);
};

const assistantReplies = () =>
  hook.messages.filter(m => m.role === 'assistant' && m.id !== 'welcome').map(m => m.content);

describe('usePromptAssistant — a closed stream', () => {
  it('shows the ended line and clears isStreaming when the stream closes', async () => {
    await init();
    connect();
    await send('Make a closures quiz');
    expect(hook.isStreaming).toBe(true);

    const stream = latestStream();
    act(() => {
      stream.readyState = FakeEventSource.CLOSED;
      stream.emit('error');
    });

    expect(hook.error).toBe(ENDED);
    expect(hook.isStreaming).toBe(false);
  });

  it('keeps waiting through a transient drop (EventSource reconnects on its own)', async () => {
    await init();
    connect();
    await send('Make a closures quiz');

    act(() => latestStream().emit('error'));

    expect(hook.error).toBeNull();
    expect(hook.isStreaming).toBe(true);
  });

  it('sends right after init, before the stream reports connected', async () => {
    await init();
    await send('Make a closures quiz');

    expect(posts().map(p => p._action)).toEqual(['initSession', 'sendMessage']);
    expect(hook.error).toBeNull();
    expect(hook.isStreaming).toBe(true);
    expect(hook.messages.map(m => m.role)).toEqual(['assistant', 'user']);
  });

  it('posts nothing after the stream has closed', async () => {
    await init();
    connect();
    const stream = latestStream();
    act(() => {
      stream.readyState = FakeEventSource.CLOSED;
      stream.emit('error');
    });

    await send('Still there?');

    expect(posts().map(p => p._action)).toEqual(['initSession']);
    expect(hook.error).toBe(ENDED);
  });
});

describe('usePromptAssistant — an ended session', () => {
  it('closes the stream when the ended line arrives over SSE', async () => {
    await init();
    connect();
    await send('Make a closures quiz');
    const stream = latestStream();

    act(() => stream.emit('error', { error: ENDED }));

    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    expect(hook.error).toBe(ENDED);
    expect(hook.isStreaming).toBe(false);

    // The composer stays usable; a send explains itself and posts nothing.
    await send('Still there?');
    expect(posts().map(p => p._action)).toEqual(['initSession', 'sendMessage']);
    expect(hook.error).toBe(ENDED);
  });

  it('closes the stream when the ended line arrives in the POST body', async () => {
    sendReply = { ok: false, status: 500, body: { error: ENDED } };
    await init();
    connect();

    await send('Make a closures quiz');

    expect(latestStream().readyState).toBe(FakeEventSource.CLOSED);
    expect(hook.error).toBe(ENDED);
    expect(hook.isStreaming).toBe(false);
  });

  it('leaves the stream open for any other failure', async () => {
    await init();
    connect();
    await send('Make a closures quiz');
    const stream = latestStream();

    act(() => stream.emit('error', { error: GENERIC }));

    expect(stream.readyState).not.toBe(FakeEventSource.CLOSED);
    expect(hook.error).toBe(GENERIC);
    expect(hook.isStreaming).toBe(false);
  });
});

describe('usePromptAssistant — replayed replies', () => {
  it('shows a reply the stream replays on reconnect only once', async () => {
    await init();
    connect();
    await send('Make a closures quiz');
    act(() => latestStream().emit('assistant_response', { messageId: 'm1', content: 'First' }));

    // A second turn is in flight when the stream reconnects and replays m1.
    await send('Make it harder');
    act(() => {
      latestStream().emit('connected', { sessionId: 's1' });
      latestStream().emit('assistant_response', { messageId: 'm1', content: 'First' });
    });

    expect(assistantReplies()).toEqual(['First']);
    expect(hook.isStreaming).toBe(true);

    act(() => latestStream().emit('assistant_response', { messageId: 'm2', content: 'Second' }));
    expect(assistantReplies()).toEqual(['First', 'Second']);
    expect(hook.isStreaming).toBe(false);
  });

  it('shows two replies with the same text but different ids', async () => {
    await init();
    connect();
    await send('Make a closures quiz');
    act(() => latestStream().emit('assistant_response', { messageId: 'm1', content: 'Done.' }));
    await send('And a rubric');
    act(() => latestStream().emit('assistant_response', { messageId: 'm2', content: 'Done.' }));

    expect(assistantReplies()).toEqual(['Done.', 'Done.']);
    expect(hook.messages.filter(m => m.role === 'assistant').map(m => m.id)).toEqual([
      'welcome',
      'm1',
      'm2',
    ]);
  });
});

describe('usePromptAssistant — new conversation', () => {
  it('opens the stream with the classroom so it can be authorized after a restart', async () => {
    await init();
    expect(latestStream().url).toBe('/api/quiz/prompt-assistant/stream/s1?org=cs52');
  });

  it('ends the session, then opens a new one with the same form context', async () => {
    await init();
    connect();
    act(() => latestStream().emit('error', { error: ENDED }));
    const oldStream = latestStream();

    await act(async () => {
      await hook.restart(FORM_CONTEXT, REPO);
    });

    const [, end, reinit] = posts();
    expect(posts().map(p => p._action)).toEqual(['initSession', 'endSession', 'initSession']);
    expect(end).toMatchObject({ classroomSlug: 'cs52', sessionId: 's1' });
    expect(JSON.parse(reinit.formContext)).toEqual(FORM_CONTEXT);
    // The session was not code-aware, so the repo stays out.
    expect(reinit.exampleRepoUrl).toBeUndefined();

    expect(oldStream.readyState).toBe(FakeEventSource.CLOSED);
    expect(latestStream()).not.toBe(oldStream);
    expect(latestStream().url).toBe('/api/quiz/prompt-assistant/stream/s2?org=cs52');
    expect(hook.sessionId).toBe('s2');
    expect(hook.error).toBeNull();
    expect(hook.messages.map(m => m.id)).toEqual(['welcome']);
  });

  it('carries the repo over when the session explored it', async () => {
    codeAware = true;
    await init(REPO);

    await act(async () => {
      await hook.restart(FORM_CONTEXT, REPO);
    });

    const [, , reinit] = posts();
    expect(reinit._action).toBe('initSession');
    expect(reinit.exampleRepoUrl).toBe(REPO);
  });

  it('is pending from the start, while the old session is still ending', async () => {
    await init();
    const releaseEnd = hold('endSession');

    let restarting!: Promise<unknown>;
    act(() => {
      restarting = hook.restart(FORM_CONTEXT);
    });
    expect(hook.isInitializing).toBe(true);

    await act(async () => {
      releaseEnd();
      await restarting;
    });
    expect(hook.isInitializing).toBe(false);
    expect(hook.sessionId).toBe('s2');
  });

  it("ignores the old conversation's outcome when it lands after a new one began", async () => {
    await init();
    connect();
    sendReply = { ok: false, status: 500, body: { error: ENDED } };
    const releaseSend = hold('sendMessage');

    // The turn is in flight when the SSE ended line arrives; the user starts
    // over before the POST answers.
    let sending!: Promise<void>;
    act(() => {
      sending = hook.sendMessage('Make a closures quiz');
    });
    act(() => latestStream().emit('error', { error: ENDED }));
    await act(async () => {
      await hook.restart(FORM_CONTEXT);
    });
    const newStream = latestStream();
    expect(hook.sessionId).toBe('s2');

    await act(async () => {
      releaseSend();
      await sending;
    });

    expect(newStream.readyState).not.toBe(FakeEventSource.CLOSED);
    expect(hook.error).toBeNull();
    expect(hook.isStreaming).toBe(false);
    expect(hook.messages.map(m => m.id)).toEqual(['welcome']);
  });
});

describe('usePromptAssistant — a superseded start', () => {
  it('ends the older of two overlapping starts and keeps the newer', async () => {
    const releaseInit = hold('initSession');

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = hook.initSession(FORM_CONTEXT);
      second = hook.initSession(FORM_CONTEXT);
    });
    await act(async () => {
      releaseInit();
      await Promise.all([first, second]);
    });

    expect(posts().map(p => p._action)).toEqual(['initSession', 'initSession', 'endSession']);
    expect(posts()[2]).toMatchObject({ classroomSlug: 'cs52', sessionId: 's1' });
    expect(FakeEventSource.instances.map(s => s.url)).toEqual([
      '/api/quiz/prompt-assistant/stream/s2?org=cs52',
    ]);
    expect(hook.sessionId).toBe('s2');
    expect(hook.isInitializing).toBe(false);
  });
});

describe('usePromptAssistant — unmount', () => {
  it('ends the session when the panel unmounts', async () => {
    await init();
    const stream = latestStream();

    unmount();

    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    expect(posts().map(p => p._action)).toEqual(['initSession', 'endSession']);
    expect(posts()[1]).toMatchObject({ classroomSlug: 'cs52', sessionId: 's1' });
  });

  it('posts nothing on unmount when no session started', async () => {
    unmount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends a session that finishes starting after the panel unmounted, and opens no stream', async () => {
    const releaseInit = hold('initSession');
    let starting!: Promise<unknown>;
    act(() => {
      starting = hook.initSession(FORM_CONTEXT);
    });

    unmount();
    await act(async () => {
      releaseInit();
      await starting;
    });

    expect(posts().map(p => p._action)).toEqual(['initSession', 'endSession']);
    expect(posts()[1]).toMatchObject({ classroomSlug: 'cs52', sessionId: 's1' });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('opens nothing when the panel unmounts while a new conversation ends the old one', async () => {
    await init();
    const releaseEnd = hold('endSession');
    let restarting!: Promise<unknown>;
    act(() => {
      restarting = hook.restart(FORM_CONTEXT);
    });

    unmount();
    await act(async () => {
      releaseEnd();
      await restarting;
    });

    // One end (the restart's, not a second from the unmount) and no new start.
    expect(posts().map(p => p._action)).toEqual(['initSession', 'endSession']);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
