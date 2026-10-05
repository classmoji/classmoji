import { describe, expect, it } from 'vitest';

import {
  AGENT_TOUCHED_MAX,
  AGENT_TOUCH_EXPIRE_MS,
  AgentTouchTracker,
  agentBatchesFromStates,
  agentColor,
  agentDisplayName,
  normalizeAgentSession,
  splitAgentName,
  textOnColor,
} from '../agent.ts';
import { USER_COLORS, userColor } from '../color.ts';

const agent = (name: string, touched?: unknown, color = '#0090ff') => ({
  user: { name, color, agent: true },
  ...(touched !== undefined ? { touched } : {}),
});

describe('agent session ids', () => {
  it('keeps plain tokens and drops anything else', () => {
    expect(normalizeAgentSession('3f1c2a9e-0b1d-4c55-9a6e-5d2f1b7c8e90')).toBe(
      '3f1c2a9e-0b1d-4c55-9a6e-5d2f1b7c8e90'
    );
    expect(normalizeAgentSession('abc.DEF_1:2-3')).toBe('abc.DEF_1:2-3');
    expect(normalizeAgentSession('')).toBeNull();
    expect(normalizeAgentSession('has space')).toBeNull();
    expect(normalizeAgentSession('a'.repeat(129))).toBeNull();
    expect(normalizeAgentSession('<script>')).toBeNull();
    expect(normalizeAgentSession(42)).toBeNull();
    expect(normalizeAgentSession(undefined)).toBeNull();
  });
});

describe('agent names', () => {
  it('labels one session plainly and several by number', () => {
    expect(agentDisplayName('Ada Lovelace', null)).toBe('Ada Lovelace (agent)');
    expect(agentDisplayName('Ada Lovelace', 2)).toBe('Ada Lovelace (agent 2)');
  });

  it('splits a label back into the name and its tag', () => {
    expect(splitAgentName('Ada Lovelace (agent)')).toEqual({ name: 'Ada Lovelace', tag: 'agent' });
    expect(splitAgentName('Ada Lovelace (agent 12)')).toEqual({
      name: 'Ada Lovelace',
      tag: 'agent 12',
    });
    expect(splitAgentName('Ada (Countess) Lovelace')).toEqual({
      name: 'Ada (Countess) Lovelace',
      tag: null,
    });
    expect(splitAgentName('Ada (agents)')).toEqual({ name: 'Ada (agents)', tag: null });
    // Nothing before the tag: the whole string stays the name.
    expect(splitAgentName('(agent)')).toEqual({ name: '(agent)', tag: 'agent' });
  });
});

describe('agent colours', () => {
  it('is stable per session and avoids the colours it is told to', () => {
    const first = agentColor('u1:session-a');
    expect(agentColor('u1:session-a')).toBe(first);
    expect(USER_COLORS).toContain(first);
    expect(agentColor('u1:session-a', [first])).not.toBe(first);
  });

  it("differs from the person's own colour and from their other sessions", () => {
    const own = userColor('u1');
    const one = agentColor('u1:a', [own]);
    const two = agentColor('u1:b', [own, one]);
    expect(new Set([own, one, two]).size).toBe(3);
  });

  it('still answers when every colour is taken', () => {
    expect(USER_COLORS).toContain(agentColor('k', USER_COLORS));
  });

  it('picks readable chip text', () => {
    expect(textOnColor('#d6a000')).toBe('#000000');
    expect(textOnColor('#3e63dd')).toBe('#ffffff');
    expect(textOnColor('red')).toBe('#ffffff');
  });
});

describe('agentBatchesFromStates', () => {
  it('reads agents only, never the local client, and only well-formed lists', () => {
    const states: Array<[number, unknown]> = [
      [1, { user: { name: 'Ada', color: '#0090ff' }, touched: { ids: ['x'], seq: 1 } }],
      [2, agent('Bot (agent)', { ids: ['a', 'b'], seq: 3 })],
      [3, agent('Local (agent)', { ids: ['c'], seq: 1 })],
      [4, agent('No list (agent)')],
      [5, agent('Bad seq (agent)', { ids: ['d'], seq: 'x' })],
      [6, agent('Bad ids (agent)', { ids: [1, '', null], seq: 1 })],
      [7, null],
      [8, agent('Odd colour (agent)', { ids: ['e'], seq: 1 }, 'url(x)')],
    ];
    const batches = agentBatchesFromStates(states, 3);
    expect(batches.map(b => [b.clientId, b.ids])).toEqual([
      [2, ['a', 'b']],
      [8, ['e']],
    ]);
    expect(batches[1].color).toBe('#6b7280');
  });

  it('keeps only the last AGENT_TOUCHED_MAX ids of an over-long list', () => {
    const ids = Array.from({ length: AGENT_TOUCHED_MAX + 10 }, (_, i) => `b${i}`);
    const [batch] = agentBatchesFromStates([[2, agent('Bot (agent)', { ids, seq: 1 })]], 1);
    expect(batch.ids).toHaveLength(AGENT_TOUCHED_MAX);
    expect(batch.ids.at(-1)).toBe(ids.at(-1));
  });
});

describe('AgentTouchTracker', () => {
  function tracker() {
    let now = 1_000;
    const t = new AgentTouchTracker(() => now);
    return { t, tick: (ms: number) => (now += ms) };
  }

  it('shows a new batch, and the same state sent again changes nothing', () => {
    const { t, tick } = tracker();
    const states: Array<[number, unknown]> = [[2, agent('Bot (agent)', { ids: ['a'], seq: 1 })]];
    expect(t.update(states, 1)).toBe(true);
    expect(t.touches().map(x => x.id)).toEqual(['a']);
    tick(4_000);
    // A renewal, or only `user` changing: not a new batch, the clock does not restart.
    expect(t.update([[2, agent('Bot (agent 1)', { ids: ['a'], seq: 1 })]], 1)).toBe(false);
    tick(AGENT_TOUCH_EXPIRE_MS - 4_000);
    expect(t.sweep()).toBe(true);
    expect(t.touches()).toEqual([]);
  });

  it('restarts a block touched again and gives every batch its own number', () => {
    const { t, tick } = tracker();
    t.update([[2, agent('Bot (agent)', { ids: ['a', 'b'], seq: 1 })]], 1);
    tick(3_000);
    t.update([[2, agent('Bot (agent)', { ids: ['b'], seq: 2 })]], 1);
    const [a, b] = t.touches();
    expect(a).toMatchObject({ id: 'a', seq: 1, batch: 1 });
    expect(b).toMatchObject({ id: 'b', seq: 2, batch: 2 });
    tick(AGENT_TOUCH_EXPIRE_MS - 3_000);
    t.sweep();
    expect(t.touches().map(x => x.id)).toEqual(['b']);
    expect(t.nextExpiryIn()).toBe(3_000);
  });

  it('gives a block to whichever agent touched it last', () => {
    const { t, tick } = tracker();
    t.update([[2, agent('One (agent)', { ids: ['a'], seq: 1 }, '#e5484d')]], 1);
    tick(100);
    t.update(
      [
        [2, agent('One (agent)', { ids: ['a'], seq: 1 }, '#e5484d')],
        [3, agent('Two (agent)', { ids: ['a'], seq: 1 }, '#30a46c')],
      ],
      1
    );
    expect(t.touches()).toEqual([
      expect.objectContaining({ id: 'a', clientId: 3, name: 'Two (agent)', color: '#30a46c' }),
    ]);
  });

  it('has nothing to expire when nothing shows', () => {
    const { t } = tracker();
    expect(t.nextExpiryIn()).toBeNull();
    expect(t.update([], 1)).toBe(false);
  });
});
