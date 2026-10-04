/**
 * The live session's lifecycle (collabSession.ts) against a stub provider:
 * one document and one provider per session, the token the server checks,
 * the first sync, refusals, presence and teardown.
 */

import { test, expect } from '@playwright/test';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import type { CollabLoaderData } from '@classmoji/collab';

import {
  CollabSession,
  type CollabProviderArgs,
  type CollabProviderLike,
} from '../../app/components/editor/collab/collabSession.ts';

class StubProvider implements CollabProviderLike {
  readonly awareness: Awareness;
  destroyCalls = 0;
  constructor(readonly args: CollabProviderArgs) {
    this.awareness = new Awareness(args.document);
  }
  destroy() {
    this.destroyCalls++;
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

function open() {
  let provider: StubProvider | null = null;
  const session = new CollabSession(collab, args => (provider = new StubProvider(args)));
  return { session, provider: provider as unknown as StubProvider };
}

test.describe('CollabSession', () => {
  test('one provider for the room, with the schema version as the token', () => {
    const { session, provider } = open();
    expect(provider.args.url).toBe('ws://localhost:7710');
    expect(provider.args.name).toBe('page:p1:2');
    expect(provider.args.document).toBe(session.doc);
    expect(JSON.parse(provider.args.token)).toEqual({ schemaVersion: 7 });
    session.destroy();
  });

  test('the editor may mount after the first sync, and stays mounted through a resync', () => {
    const { session, provider } = open();
    const seen: boolean[] = [];
    session.subscribe(() => seen.push(session.getState().hasSynced));
    expect(session.getState().hasSynced).toBe(false);

    provider.args.onStatus({ status: 'connected' });
    provider.args.onSynced({ state: true });
    expect(session.getState()).toMatchObject({
      status: 'connected',
      synced: true,
      hasSynced: true,
    });

    provider.args.onStatus({ status: 'disconnected' });
    provider.args.onSynced({ state: false });
    expect(session.getState()).toMatchObject({
      status: 'disconnected',
      synced: false,
      hasSynced: true,
    });
    expect(seen.length).toBeGreaterThan(0);
    session.destroy();
  });

  test('unsynced changes are tracked for the status', () => {
    const { session, provider } = open();
    provider.args.onUnsyncedChanges({ number: 3 });
    expect(session.getState().unsyncedChanges).toBe(3);
    session.destroy();
  });

  test('a refusal destroys the provider at once and sticks', () => {
    const { session, provider } = open();
    provider.args.onAuthenticationFailed({ reason: 'stale-epoch' });
    expect(provider.destroyCalls).toBe(1);
    expect(session.getState()).toMatchObject({ rejected: 'stale-epoch', status: 'disconnected' });

    // Late events do not revive it, and a second refusal does not destroy twice.
    provider.args.onStatus({ status: 'connected' });
    expect(session.getState().status).toBe('disconnected');
    provider.args.onAuthenticationFailed({ reason: 'whatever' });
    expect(provider.destroyCalls).toBe(1);

    session.destroy();
    expect(provider.destroyCalls).toBe(1);
  });

  test('a 4403 close (the periodic re-check) is a refusal; other closes are not', () => {
    const { session, provider } = open();
    provider.args.onClose({ event: { code: 1006 } });
    expect(session.getState().rejected).toBeNull();
    expect(provider.destroyCalls).toBe(0);

    provider.args.onClose({ event: { code: 4403 } });
    expect(session.getState().rejected).toBe('forbidden');
    expect(provider.destroyCalls).toBe(1);
    session.destroy();
  });

  test('a 4409 close (room closed: flag off, page deleted) asks for a reload', () => {
    const { session, provider } = open();
    provider.args.onClose({ event: { code: 4409 } });
    expect(session.getState().rejected).toBe('reload');
    expect(provider.destroyCalls).toBe(1);
    session.destroy();
  });

  test('an `unavailable` refusal is its own reason, not forbidden', () => {
    const { session, provider } = open();
    provider.args.onAuthenticationFailed({ reason: 'unavailable' });
    expect(session.getState().rejected).toBe('unavailable');
    session.destroy();
  });

  test('local edits count as unsynced until the server has acknowledged everything', () => {
    const { session, provider } = open();
    provider.args.onStatus({ status: 'connected' });
    provider.args.onSynced({ state: true });
    expect(session.getState().localUnsynced).toBe(false);

    // A remote update (origin: the provider) is not a local edit.
    const remote = new Y.Doc();
    remote.getText('t').insert(0, 'from a peer');
    Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(remote), provider);
    expect(session.getState().localUnsynced).toBe(false);

    // A local edit is, until the provider reports nothing outstanding.
    session.doc.getText('t').insert(0, 'mine ');
    expect(session.getState().localUnsynced).toBe(true);
    provider.args.onUnsyncedChanges({ number: 1 });
    expect(session.getState().localUnsynced).toBe(true);
    provider.args.onUnsyncedChanges({ number: 0 });
    expect(session.getState().localUnsynced).toBe(false);

    // Offline: an edit stays unsynced even if the counter reads zero.
    provider.args.onStatus({ status: 'disconnected' });
    session.doc.getText('t').insert(0, 'offline ');
    provider.args.onUnsyncedChanges({ number: 0 });
    expect(session.getState()).toMatchObject({ localUnsynced: true, synced: false });
    session.destroy();
  });

  test('an unknown reason is read as forbidden', () => {
    const { session, provider } = open();
    provider.args.onAuthenticationFailed({ reason: 'permission-denied' });
    expect(session.getState().rejected).toBe('forbidden');
    session.destroy();
  });

  test('presence: the local user is in awareness before the editor mounts', () => {
    const { session, provider } = open();
    // The state awareness renews every 15 s: what keeps an idle socket alive.
    expect(provider.awareness.getLocalState()?.user).toEqual({
      id: 'u1',
      name: 'Ada Lovelace',
      color: '#0090ff',
    });
    expect(session.getState().peers).toEqual([
      { key: 'u1', name: 'Ada Lovelace', color: '#0090ff', self: true },
    ]);
    session.destroy();
  });

  test('presence follows awareness changes', () => {
    const { session, provider } = open();
    // A peer's state arriving (as the provider would apply it).
    const states = provider.awareness.getStates() as Map<number, Record<string, unknown>>;
    states.set(999, { user: { id: 'u2', name: 'Grace Hopper', color: '#e5484d' } });
    provider.awareness.emit('change', [{ added: [999], updated: [], removed: [] }, 'remote']);
    expect(session.getState().peers.map(peer => peer.name)).toEqual([
      'Ada Lovelace',
      'Grace Hopper',
    ]);
    session.destroy();
  });

  test('destroy closes the provider and the document, and stops notifying', () => {
    const { session, provider } = open();
    let notified = 0;
    session.subscribe(() => notified++);
    session.destroy();
    expect(provider.destroyCalls).toBe(1);
    expect(session.isDestroyed).toBe(true);
    expect(session.doc.isDestroyed).toBe(true);
    provider.args.onSynced({ state: true });
    expect(notified).toBe(0);
    session.destroy();
    expect(provider.destroyCalls).toBe(1);
  });

  test('two sessions for two rooms are independent', () => {
    const a = open();
    const b = open();
    expect(a.session.doc).not.toBe(b.session.doc);
    a.session.destroy();
    expect(b.provider.destroyCalls).toBe(0);
    b.session.destroy();
  });
});
