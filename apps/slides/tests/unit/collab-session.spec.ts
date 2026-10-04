/**
 * The live deck session's refusal and close semantics, with a stub provider:
 * 4403 → read-only (forbidden), 4409 → reload the route, `unavailable` → try
 * again (never permanent read-only), stale rooms auto-reload only with
 * nothing unsent, and the leave guard while edits are on their way.
 */
import { test, expect } from '@playwright/test';
import type { CollabLoaderData } from '@classmoji/collab';

import {
  liveLeaveRisk,
  mayAutoReloadStale,
  checkpointAnswersSaveVersion,
  checkpointFromRow,
  initialsOf,
  normalizeRejectReason,
  parseStatelessMessage,
  savedToGitHubStatus,
  peersFromAwareness,
  rejectionNotice,
} from '../../app/utils/collab/collab.ts';
import { DeckCollabSession, type CollabProviderArgs } from '../../app/utils/collab/session.ts';

const COLLAB: CollabLoaderData = {
  wsUrl: 'ws://localhost:7710',
  room: 'deck:slide-1:1',
  epoch: 1,
  schemaVersion: 1,
  user: { id: 'u1', name: 'Ada', color: '#000' },
};

function stubbed() {
  let args: CollabProviderArgs | null = null;
  let destroyed = 0;
  const session = new DeckCollabSession(COLLAB, a => {
    args = a;
    return {
      awareness: null,
      hasUnsyncedChanges: false,
      destroy: () => {
        destroyed++;
      },
    };
  });
  return { session, args: () => args as unknown as CollabProviderArgs, destroyed: () => destroyed };
}

test.describe('refusals and closes', () => {
  test('4403 close → forbidden, provider stopped', () => {
    const t = stubbed();
    t.args().onClose({ event: { code: 4403 } });
    expect(t.session.getState().rejected).toBe('forbidden');
    expect(t.destroyed()).toBe(1);
    expect(rejectionNotice('forbidden').action).toBe('readonly');
  });

  test('4409 close → reload the route (not read-only)', () => {
    const t = stubbed();
    t.args().onClose({ event: { code: 4409 } });
    expect(t.session.getState().reloadRequired).toBe(true);
    expect(t.session.getState().rejected).toBeNull();
  });

  test('an ordinary close just reconnects', () => {
    const t = stubbed();
    t.args().onClose({ event: { code: 1006 } });
    expect(t.session.getState().rejected).toBeNull();
    expect(t.destroyed()).toBe(0);
  });

  test('unavailable → try again with Reload, never read-only', () => {
    const t = stubbed();
    t.args().onAuthenticationFailed({ reason: 'unavailable' });
    expect(t.session.getState().rejected).toBe('unavailable');
    expect(rejectionNotice('unavailable')).toEqual({
      action: 'prompt',
      message: "Couldn't connect to live editing. Try again.",
    });
    expect(normalizeRejectReason('permission-denied')).toBe('forbidden');
  });

  test('ready: connected and synced since the last (re)connect', () => {
    const t = stubbed();
    const seen: boolean[] = [];
    t.session.onReady(ready => seen.push(ready));
    t.args().onStatus({ status: 'connected' });
    expect(t.session.ready).toBe(false);
    t.args().onSynced({ state: true });
    expect(t.session.ready).toBe(true);
    t.args().onStatus({ status: 'connecting' });
    expect(t.session.ready).toBe(false);
    t.args().onStatus({ status: 'connected' });
    expect(t.session.ready).toBe(false); // not until the resync
    t.args().onSynced({ state: true });
    expect(seen).toEqual([true, false, true]);
  });

  test('stale rooms auto-reload only with nothing unsent', () => {
    expect(mayAutoReloadStale(0)).toBe(true);
    expect(mayAutoReloadStale(2)).toBe(false);
  });

  test('leave guard: editing and not in sync', () => {
    const base = {
      editing: true,
      unsyncedChanges: 0,
      status: 'connected' as const,
      localPending: false,
    };
    expect(liveLeaveRisk(base)).toBe(false);
    expect(liveLeaveRisk({ ...base, unsyncedChanges: 1 })).toBe(true);
    expect(liveLeaveRisk({ ...base, localPending: true })).toBe(true);
    expect(liveLeaveRisk({ ...base, status: 'disconnected' })).toBe(true);
    // After Done: still guarded until every update is acknowledged.
    expect(liveLeaveRisk({ ...base, editing: false, unsyncedChanges: 3 })).toBe(true);
    expect(liveLeaveRisk({ ...base, editing: false, status: 'disconnected' })).toBe(false);
  });

  test('agents: marked, named without the suffix, initials from the name', () => {
    const peers = peersFromAwareness(
      [
        [1, { user: { id: 'u1', name: 'Ada Lovelace', color: '#000' } }],
        [99, { user: { name: 'Ada Lovelace (agent)', color: '#111', agent: true } }],
      ],
      1,
      'u1'
    );
    expect(peers).toHaveLength(2);
    const agent = peers.find(p => p.agent);
    expect(agent).toMatchObject({ name: 'Ada Lovelace', agent: true, self: false });
    expect(initialsOf('Ada Lovelace (agent)')).toBe('AL');
  });

  test('checkpoint messages: saved-to-GitHub line and the Save version answer', () => {
    const t = stubbed();
    t.args().onStateless({
      payload: JSON.stringify({
        type: 'checkpoint',
        at: '2026-10-04T03:00:00Z',
        commit: 'abcdef1234',
      }),
    });
    expect(t.session.getState().lastCheckpoint).toMatchObject({ commit: 'abcdef1234', seq: 1 });
    t.args().onStateless({ payload: JSON.stringify({ type: 'deck-meta', title: 'Renamed' }) });
    expect(t.session.getState().liveTitle).toBe('Renamed');
    t.args().onStateless({ payload: 'not json' });
    t.args().onStateless({ payload: JSON.stringify({ type: 'preview-changed' }) });
    t.args().onStateless({ payload: JSON.stringify({ type: 'preview-changed' }) });
    expect(t.session.getState().previewSeq).toBe(2);
    expect(parseStatelessMessage({ type: 'other' })).toBeNull();

    const now = Date.parse('2026-10-04T03:02:00Z');
    expect(savedToGitHubStatus({ at: '2026-10-04T03:00:00Z', commit: 'abcdef1234' }, now)).toEqual({
      tone: 'saved',
      label: 'Saved to GitHub 2 minutes ago',
      title: 'Commit abcdef1',
    });
    expect(
      savedToGitHubStatus({ at: '2026-10-04T03:00:00Z', error: 'push refused' }, now)
    ).toMatchObject({
      tone: 'unsaved',
      label: 'Not saved to GitHub yet',
      title: 'push refused',
    });
    expect(checkpointAnswersSaveVersion({ at: '2026-10-04T03:00:00Z' }, null)).toBe(false);
    expect(checkpointAnswersSaveVersion({ at: '2026-10-04T03:00:00Z' }, now - 110_000)).toBe(true);
    expect(checkpointAnswersSaveVersion({ at: '2026-10-04T02:00:00Z' }, now)).toBe(false);
  });

  test('an agent on a slide is placed there', () => {
    const peers = peersFromAwareness(
      [[5, { user: { name: 'Ada (agent)', color: '#111', agent: true }, slide: 's9' }]],
      1,
      'me'
    );
    expect(peers[0]).toMatchObject({ agent: true, slideId: 's9', name: 'Ada' });
  });
});

test.describe('saved to GitHub before runs were recorded', () => {
  test('clean with no recorded run: saved, no time; the commit in the tooltip when known', () => {
    expect(savedToGitHubStatus({ at: '', commit: 'c972c0c5aa' }, Date.now())).toEqual({
      tone: 'saved',
      label: 'Saved to GitHub',
      title: 'Commit c972c0c',
    });
    expect(savedToGitHubStatus({ at: '' }, Date.now())).toEqual({
      tone: 'saved',
      label: 'Saved to GitHub',
      title: undefined,
    });
    // It answers no pending Save version (only a real run does).
    expect(checkpointAnswersSaveVersion({ at: '' }, Date.now())).toBe(false);
  });

  test('which rows read as saved', () => {
    const row = {
      last_checkpoint_at: null,
      last_checkpoint_error: null,
      pushed_commit: 'c972c0c5aa',
      version: 4,
      pushed_version: 4,
    };
    expect(checkpointFromRow(row)).toEqual({ at: '', commit: 'c972c0c5aa' });
    expect(checkpointFromRow({ ...row, pushed_commit: null })).toEqual({ at: '' });
    expect(checkpointFromRow({ ...row, version: 5 })).toBeNull(); // unpushed edits
    expect(checkpointFromRow(null)).toEqual({ at: '' }); // only git has it
    const at = new Date('2026-10-04T03:00:00Z');
    expect(checkpointFromRow({ ...row, last_checkpoint_at: at })).toEqual({
      at: at.toISOString(),
      commit: 'c972c0c5aa',
    });
  });
});
