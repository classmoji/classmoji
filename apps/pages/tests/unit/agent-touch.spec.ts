/**
 * What an agent just changed, on a live page: the session's touches (from
 * awareness, through the shared tracker), the stylesheet that marks those
 * blocks (agentTouch.ts), and agent names in presence.
 */

import { test, expect } from '@playwright/test';
import { Awareness } from 'y-protocols/awareness';
import { AGENT_TOUCH_EXPIRE_MS, type AgentTouch, type CollabLoaderData } from '@classmoji/collab';

import { agentTouchCss, cssString } from '../../app/components/editor/collab/agentTouch.ts';
import {
  AGENT_CURSOR_LABEL_CSS,
  isAgentCursorUser,
  renderLiveCursor,
} from '../../app/components/editor/collab/liveCursor.ts';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import {
  CollabSession,
  type CollabProviderArgs,
  type CollabProviderLike,
} from '../../app/components/editor/collab/collabSession.ts';
import { peerLabel, peersFromAwareness } from '../../app/utils/collab.ts';

const touch = (overrides: Partial<AgentTouch> = {}): AgentTouch => ({
  id: 'b1',
  clientId: 7,
  seq: 1,
  name: 'Ada (agent)',
  color: '#0090ff',
  at: 0,
  batch: 1,
  ...overrides,
});

test.describe('agentTouchCss', () => {
  test('marks each touched block and names the agent in a chip', () => {
    const css = agentTouchCss([touch(), touch({ id: 'b2' })], 'page-editor');
    expect(css).toContain(
      '.page-editor .bn-block[data-id="b1"],\n.page-editor .bn-block[data-id="b2"] {'
    );
    expect(css).toContain('--cm-agent: #0090ff');
    expect(css).toContain('box-shadow: inset 3px 0 0 var(--cm-agent)');
    expect(css).toContain('::after { content: "Ada (agent)" / ""');
    // Hidden from assistive tech: the header avatars say who is here.
    expect(css).toMatch(/content: "[^"]*" \/ ""/);
  });

  test('is empty with nothing to show', () => {
    expect(agentTouchCss([], 'page-editor')).toBe('');
  });

  test('has a dark variant and fades only without reduced motion', () => {
    const css = agentTouchCss([touch()], 'page-editor');
    expect(css).toContain('.dark .page-editor { --cm-agent-mix: 24%; }');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    // The fade runs only inside that media query: reduced motion keeps the static mark.
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\)[^\n]*$/m, '');
    expect(outside).not.toContain('animation:');
    expect(css).toContain('animation: cm-agent-touch-1-mark 5000ms ease-out forwards');
  });

  test('names each batch its own fade, so only a new batch restarts it', () => {
    const css = agentTouchCss(
      [touch({ id: 'a', batch: 3 }), touch({ id: 'b', batch: 4, clientId: 8 })],
      'page-editor'
    );
    expect(css).toContain('@keyframes cm-agent-touch-3-mark');
    expect(css).toContain('@keyframes cm-agent-touch-4-mark');
    expect(css).toMatch(/data-id="a"\] \{ animation: cm-agent-touch-3-mark/);
  });

  test('escapes ids and names, and never closes the style element', () => {
    const css = agentTouchCss(
      [
        touch({
          id: 'x"] , body { color: red } [a="',
          name: 'Eve </style><script>x()</script> "q" \\',
        }),
      ],
      'page-editor'
    );
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('<script>');
    expect(css).toContain('[data-id="x\\"] , body { color: red } [a=\\""]');
    expect(cssString('a"b\\c\nd<e')).toBe('"a\\"b\\\\c d\\3c e"');
  });

  test('only a 6-digit hex colour reaches the stylesheet', () => {
    const css = agentTouchCss([touch({ color: 'red; } body { display: none' })], 'page-editor');
    expect(css).toContain('--cm-agent: #6b7280');
    expect(css).not.toContain('display: none');
  });
});

// ─── The session's touches ───────────────────────────────────────────────────

class StubProvider implements CollabProviderLike {
  readonly awareness: Awareness;
  constructor(readonly args: CollabProviderArgs) {
    this.awareness = new Awareness(args.document);
  }
  destroy() {
    this.awareness.destroy();
  }
}

const collab: CollabLoaderData = {
  wsUrl: 'ws://localhost:7710',
  room: 'page:p1:2',
  epoch: 2,
  schemaVersion: 7,
  user: { id: 'u1', name: 'Ada Lovelace', color: '#0090ff' },
};

function openSession() {
  let now = 10_000;
  let provider: StubProvider | null = null;
  const session = new CollabSession(
    collab,
    args => (provider = new StubProvider(args)),
    () => now
  );
  const stub = provider as unknown as StubProvider;
  const remote = (clientId: number, state: Record<string, unknown>) => {
    (stub.awareness.getStates() as Map<number, Record<string, unknown>>).set(clientId, state);
    stub.awareness.emit('change', [{ added: [], updated: [clientId], removed: [] }, 'remote']);
  };
  return { session, remote, tick: (ms: number) => (now += ms) };
}

const agentState = (seq: number, ids: string[], name = 'Grace Hopper (agent)') => ({
  user: { name, color: '#30a46c', agent: true },
  touched: { ids, seq },
});

test.describe('CollabSession agent touches', () => {
  test('a new batch shows; the same state again does not restart it; it expires', () => {
    const { session, remote, tick } = openSession();
    remote(50, agentState(1, ['b1', 'b2']));
    const first = session.getState().agentTouches;
    expect(first.map(t => t.id)).toEqual(['b1', 'b2']);

    tick(3_000);
    // A renewal, or a new `user` (the label renumbered), keeps the same touches.
    remote(50, agentState(1, ['b1', 'b2'], 'Grace Hopper (agent 1)'));
    expect(session.getState().agentTouches).toBe(first);
    // A person's caret moving is not an agent batch either.
    remote(60, { user: { id: 'u2', name: 'Grace Hopper', color: '#e5484d' }, cursor: {} });
    expect(session.getState().agentTouches).toBe(first);

    tick(AGENT_TOUCH_EXPIRE_MS - 3_000);
    // Expired: gone at the next look (the session also sweeps on its own timer).
    remote(60, { user: { id: 'u2', name: 'Grace Hopper', color: '#e5484d' }, cursor: null });
    expect(session.getState().agentTouches).toEqual([]);
    session.destroy();
  });

  test('a later batch from the same agent replaces the touch of the blocks it names', () => {
    const { session, remote, tick } = openSession();
    remote(50, agentState(1, ['b1']));
    tick(1_000);
    remote(50, agentState(2, ['b1', 'b3']));
    const touches = session.getState().agentTouches;
    expect(touches.map(t => [t.id, t.seq, t.batch])).toEqual([
      ['b1', 2, 2],
      ['b3', 2, 2],
    ]);
    session.destroy();
  });

  test('ignores people and malformed states', () => {
    const { session, remote } = openSession();
    remote(60, {
      user: { id: 'u2', name: 'Grace', color: '#e5484d' },
      touched: { ids: ['x'], seq: 1 },
    });
    remote(61, { user: { name: 'Bot (agent)', color: '#30a46c', agent: true }, touched: 'nope' });
    remote(62, {
      user: { name: 'Bot (agent)', color: '#30a46c', agent: true },
      touched: { ids: [1], seq: 1 },
    });
    expect(session.getState().agentTouches).toEqual([]);
    session.destroy();
  });
});

test.describe('agent names in presence', () => {
  test('a numbered agent keeps its number in its label', () => {
    const peers = peersFromAwareness(
      [
        [1, { user: { id: 'u1', name: 'Ada', color: '#0090ff' } }],
        [2, { user: { name: 'Grace (agent 2)', color: '#30a46c', agent: true } }],
        [3, { user: { name: 'Grace (agent 1)', color: '#e5484d', agent: true } }],
        [4, { user: { name: 'Grace', color: '#d6409f', id: 'u2' } }],
      ],
      1,
      'u1'
    );
    expect(peers.map(peerLabel)).toEqual([
      'Ada (you)',
      'Grace',
      'Grace (agent 1)',
      'Grace (agent 2)',
    ]);
    expect(peers.find(p => p.agentTag === 'agent 2')?.name).toBe('Grace');
  });
});

test.describe('remote carets', () => {
  test('an agent is recognised by its flag or its "(agent…)" name', () => {
    expect(isAgentCursorUser({ name: 'Ada', agent: true })).toBe(true);
    expect(isAgentCursorUser({ name: 'Ada (agent 2)' })).toBe(true);
    expect(isAgentCursorUser({ name: 'Ada Lovelace' })).toBe(false);
  });

  test("BlockNote's caret, with an agent's marked so its name tag stays", () => {
    const { document } = new JSDOM('<!doctype html><body></body>').window;
    const agent = renderLiveCursor(
      { name: 'Ada (agent)', color: '#0090ff', agent: true },
      document
    );
    expect(agent.classList.contains('bn-collaboration-cursor__base')).toBe(true);
    expect(agent.hasAttribute('data-agent')).toBe(true);
    const label = agent.querySelector(
      '.bn-collaboration-cursor__caret > .bn-collaboration-cursor__label'
    );
    expect(label?.textContent).toBe('Ada (agent)');
    expect(label?.getAttribute('style')).toContain('background-color: #0090ff');

    const person = renderLiveCursor({ name: 'Grace', color: '#e54666' }, document);
    expect(person.hasAttribute('data-agent')).toBe(false);
    expect(AGENT_CURSOR_LABEL_CSS).toContain(
      '.bn-collaboration-cursor__base[data-agent] .bn-collaboration-cursor__label'
    );
  });
});
