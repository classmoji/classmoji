/**
 * Live editing in the pages app: the collab loader data, the env it is built
 * from, the internal API client, and the gate that switches the git save
 * machinery off for a live page.
 *
 * The decisions are pure modules, called directly. Only the route
 * component's wiring (which needs a DOM and a router) is pinned from source.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { userColor } from '@classmoji/collab';
import { SCHEMA_VERSION } from '@classmoji/page-schema/constants';

import {
  DEV_COLLAB_INTERNAL_SECRET,
  buildCollabLoaderData,
  collabEnv,
  collabInternalRequest,
  CollabRequestError,
  pageInternalPath,
} from '../../app/utils/collabEnv.server.ts';
import {
  LIVE_CONNECT_GRACE_MS,
  offerCopyUnsaved,
  SAVE_VERSION_MESSAGES,
  SAVE_VERSION_WAIT_MS,
  applyPageMeta,
  checkpointAnswersSaveVersion,
  isSaveVersionRequestId,
  newSaveVersionRequestId,
  saveVersionGate,
  saveVersionOutcome,
  savedToGitHubAnnouncement,
  initialCheckpoint,
  parseStatelessMessage,
  relativeTimeFrom,
  savedToGitHubStatus,
  autoReloadAllowed,
  claimStaleReload,
  deriveSyncStatus,
  initialsOf,
  isCollabMode,
  liveLeaveUnsafe,
  liveUnreachable,
  normalizeRejectReason,
  peerLabel,
  peersFromAwareness,
  readCoverValue,
  rejectionNotice,
  saveMachineryEnabled,
  type CollabLoaderData,
} from '../../app/utils/collab.ts';
import {
  LIVE_PAGE_MESSAGE,
  LIVE_UNAVAILABLE_MESSAGE,
  joinsLiveRoom,
  liveEditingBlocked,
  liveIntentRefusal,
  versionNote,
  VERSION_NOTE_MAX,
} from '../../app/utils/liveGates.ts';
import { closeBeforeDelete } from '../../app/utils/collab.server.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const ROUTE = source('../../app/routes/$classroomSlug.$pageId/route.tsx');

const collabData = (over: Partial<CollabLoaderData> = {}): CollabLoaderData => ({
  wsUrl: 'ws://localhost:7710',
  room: 'page:p1:1',
  epoch: 1,
  schemaVersion: SCHEMA_VERSION,
  user: { id: 'u1', name: 'Ada Lovelace', color: '#0090ff' },
  ...over,
});

// ─── Env ─────────────────────────────────────────────────────────────────────

test.describe('collabEnv', () => {
  test('dev falls back to the devport collab port and the shared dev secret', () => {
    expect(collabEnv({ NODE_ENV: 'development', COLLAB_PORT: '7710' })).toEqual({
      httpUrl: 'http://localhost:7710',
      wsUrl: 'ws://localhost:7710',
      secret: DEV_COLLAB_INTERNAL_SECRET,
    });
  });

  test('dev without a port uses the default collab port', () => {
    expect(collabEnv({ NODE_ENV: 'development' })?.wsUrl).toBe('ws://localhost:7700');
  });

  test('explicit values win, trailing slashes are dropped', () => {
    expect(
      collabEnv({
        NODE_ENV: 'production',
        COLLAB_URL: 'https://collab.internal/',
        COLLAB_WS_URL: 'wss://collab.classmoji.io/',
        COLLAB_INTERNAL_SECRET: 's3cret',
      })
    ).toEqual({
      httpUrl: 'https://collab.internal',
      wsUrl: 'wss://collab.classmoji.io',
      secret: 's3cret',
    });
  });

  test('outside production the WebSocket URL may be derived from COLLAB_URL', () => {
    expect(collabEnv({ NODE_ENV: 'development', COLLAB_URL: 'https://collab.test' })?.wsUrl).toBe(
      'wss://collab.test'
    );
  });

  test('production requires COLLAB_WS_URL (never derived from the internal URL)', () => {
    expect(
      collabEnv({
        NODE_ENV: 'production',
        COLLAB_URL: 'http://collab.internal:7700',
        COLLAB_INTERNAL_SECRET: 's',
      })
    ).toBeNull();
  });

  test('production without a URL or a secret switches live editing off', () => {
    expect(collabEnv({ NODE_ENV: 'production', COLLAB_INTERNAL_SECRET: 's' })).toBeNull();
    expect(collabEnv({ NODE_ENV: 'production', COLLAB_URL: 'https://c' })).toBeNull();
  });
});

// ─── Loader data ─────────────────────────────────────────────────────────────

test.describe('buildCollabLoaderData', () => {
  const env = { wsUrl: 'ws://localhost:7710', httpUrl: 'http://localhost:7710', secret: 'x' };

  test('names the room page:<id>:<epoch> and carries the schema version', () => {
    const data = buildCollabLoaderData({
      env,
      pageId: 'page-1',
      epoch: 3,
      user: { id: 'user-1', name: 'Ada' },
    });
    expect(data).toEqual({
      wsUrl: 'ws://localhost:7710',
      room: 'page:page-1:3',
      epoch: 3,
      schemaVersion: SCHEMA_VERSION,
      user: { id: 'user-1', name: 'Ada', color: userColor('user-1') },
    });
  });

  test('an epoch that is not a positive integer reads as 1 (no row yet)', () => {
    for (const epoch of [0, -2, Number.NaN, 1.5]) {
      const data = buildCollabLoaderData({ env, pageId: 'p', epoch, user: { id: 'u', name: 'U' } });
      expect(data.room).toBe('page:p:1');
      expect(data.epoch).toBe(1);
    }
  });

  test('the colour is the same for a user on every load', () => {
    const a = buildCollabLoaderData({ env, pageId: 'p', epoch: 1, user: { id: 'u9', name: 'A' } });
    const b = buildCollabLoaderData({ env, pageId: 'q', epoch: 2, user: { id: 'u9', name: 'A' } });
    expect(a.user.color).toBe(b.user.color);
  });
});

// ─── Internal API client ─────────────────────────────────────────────────────

test.describe('collabInternalRequest', () => {
  const env = { wsUrl: 'ws://c', httpUrl: 'http://c:7710', secret: 'top' };

  test('posts JSON with the shared secret to /internal/<path>', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ version: 4 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await collabInternalRequest<{ version: number }>(
      env,
      'POST',
      pageInternalPath('p/1', 'checkpoint'),
      { actor: { userId: 'u', name: 'U' } },
      { fetchImpl }
    );
    expect(result).toEqual({ version: 4 });
    expect(calls[0].url).toBe('http://c:7710/internal/page/p%2F1/checkpoint');
    expect((calls[0].init.headers as Record<string, string>)['x-collab-secret']).toBe('top');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ actor: { userId: 'u', name: 'U' } });
  });

  test('a refusal carries its status and body', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'slide-locked' }), {
        status: 409,
      })) as unknown as typeof fetch;
    const error = await collabInternalRequest<never>(env, 'GET', '/page/p/snapshot', undefined, {
      fetchImpl,
    }).catch((e: unknown) => e as CollabRequestError);
    expect(error).toBeInstanceOf(CollabRequestError);
    expect(error.status).toBe(409);
    expect(error.body).toEqual({ error: 'slide-locked' });
  });

  test('an unreachable server is status 0', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const error = await collabInternalRequest<never>(env, 'GET', '/page/p/snapshot', undefined, {
      fetchImpl,
    }).catch((e: unknown) => e as CollabRequestError);
    expect(error).toBeInstanceOf(CollabRequestError);
    expect(error.status).toBe(0);
  });
});

// ─── Save machinery gating ───────────────────────────────────────────────────

test.describe('the git save machinery is off in collab mode only', () => {
  test('saveMachineryEnabled', () => {
    expect(saveMachineryEnabled({ canEdit: true, collab: null })).toBe(true);
    expect(saveMachineryEnabled({ canEdit: true, collab: undefined })).toBe(true);
    expect(saveMachineryEnabled({ canEdit: false, collab: null })).toBe(false);
    expect(saveMachineryEnabled({ canEdit: true, collab: collabData() })).toBe(false);
    expect(saveMachineryEnabled({ canEdit: false, collab: collabData() })).toBe(false);
  });

  test('isCollabMode needs a room and a server', () => {
    expect(isCollabMode(collabData())).toBe(true);
    expect(isCollabMode(collabData({ room: '' }))).toBe(false);
    expect(isCollabMode(collabData({ wsUrl: '' }))).toBe(false);
    expect(isCollabMode(null)).toBe(false);
  });

  test('the route wires every save path to saveEnabled', () => {
    // The React wiring has no DOM to run in here; the decisions it reads are
    // tested above and below, this only pins that it reads them.
    expect(ROUTE).toContain('const saveEnabled = saveMachineryEnabled({ canEdit, collab });');
    expect(ROUTE).not.toMatch(/if \(!canEdit\) return;/);
  });
});

test.describe('who joins the live room (loader)', () => {
  const base = {
    canEdit: true,
    liveClassroom: true,
    signedIn: true,
    previewActive: false,
    mutationBlocked: false,
  };

  test('an editor of a live classroom joins', () => {
    expect(joinsLiveRoom(base)).toBe(true);
  });

  test('anything missing keeps the page as it always was', () => {
    expect(joinsLiveRoom({ ...base, canEdit: false })).toBe(false);
    expect(joinsLiveRoom({ ...base, liveClassroom: false })).toBe(false);
    expect(joinsLiveRoom({ ...base, signedIn: false })).toBe(false);
    expect(joinsLiveRoom({ ...base, previewActive: true })).toBe(false);
  });

  test('a locked or unpublished classroom (read-only for this role) does not join', () => {
    expect(joinsLiveRoom({ ...base, mutationBlocked: true })).toBe(false);
  });
});

test.describe('git writes are refused for a live classroom (action)', () => {
  test('a save gets the reload banner, without a fallback-triggering code', () => {
    const refusal = liveIntentRefusal('save', true);
    expect(refusal?.status).toBe(409);
    // `live`: the git editor says the page is now live and offers a copy-out.
    expect(refusal?.body).toEqual({ conflict: true, live: true, message: LIVE_PAGE_MESSAGE });
    expect(refusal?.body).not.toHaveProperty('code');
  });

  test('both cover writes are refused with a sentence', () => {
    for (const intent of ['set-header-image', 'upload-header-image']) {
      expect(liveIntentRefusal(intent, true)).toEqual({
        status: 409,
        body: { error: LIVE_PAGE_MESSAGE },
      });
    }
  });

  test('everything else, and every intent of an unflagged classroom, carries on', () => {
    for (const intent of [
      'update-title',
      'update-width',
      'save-version',
      'preview-accept',
      'preview-discard',
      undefined,
    ]) {
      expect(liveIntentRefusal(intent, true)).toBeNull();
    }
    for (const intent of ['save', 'set-header-image', 'upload-header-image']) {
      expect(liveIntentRefusal(intent, false)).toBeNull();
    }
  });
});

test.describe('sync status', () => {
  test('offline whenever the socket is not open', () => {
    expect(deriveSyncStatus({ status: 'disconnected', synced: true, unsyncedChanges: 0 })).toBe(
      'offline'
    );
    expect(deriveSyncStatus({ status: 'connecting', synced: false, unsyncedChanges: 0 })).toBe(
      'offline'
    );
  });

  test('syncing until synced and while changes await acknowledgement', () => {
    expect(deriveSyncStatus({ status: 'connected', synced: false, unsyncedChanges: 0 })).toBe(
      'syncing'
    );
    expect(deriveSyncStatus({ status: 'connected', synced: true, unsyncedChanges: 2 })).toBe(
      'syncing'
    );
    expect(deriveSyncStatus({ status: 'connected', synced: true, unsyncedChanges: 0 })).toBe(
      'synced'
    );
    expect(
      deriveSyncStatus({
        status: 'connected',
        synced: true,
        unsyncedChanges: 0,
        localUnsynced: true,
      })
    ).toBe('syncing');
  });
});

test.describe('refusals', () => {
  test('our reasons pass through, anything else is forbidden', () => {
    expect(normalizeRejectReason('stale-epoch')).toBe('stale-epoch');
    expect(normalizeRejectReason('schema-mismatch')).toBe('schema-mismatch');
    expect(normalizeRejectReason('unavailable')).toBe('unavailable');
    expect(normalizeRejectReason('legacy-html')).toBe('legacy-html');
    expect(normalizeRejectReason('forbidden')).toBe('forbidden');
    expect(normalizeRejectReason('permission-denied')).toBe('forbidden');
    expect(normalizeRejectReason(undefined)).toBe('forbidden');
  });

  test('every refusal has a sentence; only a closed or stale room reloads by itself', () => {
    expect(rejectionNotice('reload').action).toBe('reload');
    expect(rejectionNotice('stale-epoch').action).toBe('reload');
    expect(rejectionNotice('schema-mismatch')).toEqual({
      action: 'prompt',
      message: 'Reload to get the latest editor.',
    });
    expect(rejectionNotice('unavailable')).toEqual({
      action: 'prompt',
      message: 'Couldn’t connect to live editing. Try again.',
    });
    expect(rejectionNotice('forbidden').action).toBe('readonly');
    expect(rejectionNotice('legacy-html')).toEqual({
      action: 'readonly',
      message: 'This page uses an older format and can’t be edited live yet.',
    });
    for (const reason of [
      'legacy-html',
      'reload',
      'stale-epoch',
      'schema-mismatch',
      'unavailable',
      'forbidden',
    ] as const) {
      expect(rejectionNotice(reason).message).toBeTruthy();
    }
  });

  test('a stale or closed room reloads by itself only with nothing unsynced', () => {
    expect(autoReloadAllowed('stale-epoch', false)).toBe(true);
    expect(autoReloadAllowed('stale-epoch', true)).toBe(false);
    expect(autoReloadAllowed('reload', false)).toBe(true);
    expect(autoReloadAllowed('reload', true)).toBe(false);
    expect(autoReloadAllowed('forbidden', false)).toBe(false);
    expect(autoReloadAllowed('unavailable', false)).toBe(false);
    expect(autoReloadAllowed('schema-mismatch', false)).toBe(false);
  });

  test('a stale room reloads once, then asks', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(claimStaleReload(storage, 'page:p:1')).toBe(true);
    expect(claimStaleReload(storage, 'page:p:1')).toBe(false);
    // A new room (the reload brought a new epoch) may reload again later.
    expect(claimStaleReload(storage, 'page:p:2')).toBe(true);
    expect(claimStaleReload(null, 'page:p:3')).toBe(false);
  });
});

test.describe('leaving and connecting', () => {
  test('leaving is unsafe whenever an open live editor is not synced', () => {
    const open = { hasSynced: true, refused: false };
    expect(liveLeaveUnsafe({ ...open, syncStatus: 'synced' })).toBe(false);
    expect(liveLeaveUnsafe({ ...open, syncStatus: 'syncing' })).toBe(true);
    expect(liveLeaveUnsafe({ ...open, syncStatus: 'offline' })).toBe(true);
    // Nothing editable yet, or a refused session: nothing to hold the person for.
    expect(liveLeaveUnsafe({ hasSynced: false, refused: false, syncStatus: 'offline' })).toBe(
      false
    );
    expect(liveLeaveUnsafe({ hasSynced: true, refused: true, syncStatus: 'offline' })).toBe(false);
  });

  test('"could not connect" waits out the grace period', () => {
    const waiting = { hasSynced: false, refused: false, status: 'disconnected' as const };
    expect(liveUnreachable({ ...waiting, elapsedMs: 1_000 })).toBe(false);
    expect(liveUnreachable({ ...waiting, elapsedMs: LIVE_CONNECT_GRACE_MS - 1 })).toBe(false);
    expect(liveUnreachable({ ...waiting, elapsedMs: LIVE_CONNECT_GRACE_MS })).toBe(true);
    expect(liveUnreachable({ ...waiting, status: 'connected', elapsedMs: 60_000 })).toBe(false);
    expect(liveUnreachable({ ...waiting, hasSynced: true, elapsedMs: 60_000 })).toBe(false);
    expect(liveUnreachable({ ...waiting, refused: true, elapsedMs: 60_000 })).toBe(false);
  });
});

// ─── Presence ────────────────────────────────────────────────────────────────

test.describe('peersFromAwareness', () => {
  test('one entry per user, the local user first, states without a user skipped', () => {
    const states = new Map<number, Record<string, unknown>>([
      [10, { user: { id: 'u2', name: 'Grace Hopper', color: '#e5484d' } }],
      [11, { user: { id: 'u1', name: 'Ada Lovelace', color: '#0090ff' } }],
      [12, { user: { id: 'u2', name: 'Grace Hopper', color: '#e5484d' } }], // second tab
      [13, {}],
      [14, { user: { name: 'Agent (agent)', color: '#30a46c' } }],
    ]);
    const peers = peersFromAwareness(states, 11, 'u1');
    expect(peers.map(p => [p.key, p.self])).toEqual([
      ['u1', true],
      ['client:14', false],
      ['u2', false],
    ]);
  });

  test('initials', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('grace')).toBe('G');
    expect(initialsOf('  ')).toBe('?');
  });
});

test.describe('readCoverValue', () => {
  test('a stored cover reads back; anything else is no cover', () => {
    expect(readCoverValue({ url: 'pages/a/assets/c.png', position: 30 })).toEqual({
      url: 'pages/a/assets/c.png',
      position: 30,
    });
    expect(readCoverValue({ url: 'media://x' })).toEqual({ url: 'media://x', position: 50 });
    expect(readCoverValue({ url: '' })).toBeNull();
    expect(readCoverValue(null)).toBeNull();
    expect(readCoverValue('pages/a.png')).toBeNull();
  });
});

test.describe('page delete closes the live room first', () => {
  test('when the classroom is flagged or a buffered document exists', () => {
    expect(closeBeforeDelete({ classroomFlagged: true, hasCollabDoc: false })).toBe(true);
    expect(closeBeforeDelete({ classroomFlagged: false, hasCollabDoc: true })).toBe(true);
    expect(closeBeforeDelete({ classroomFlagged: false, hasCollabDoc: false })).toBe(false);
  });
});

test.describe('agents in presence', () => {
  test('an agent shows its own initials and is marked', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { id: 'u1', name: 'Ada Lovelace', color: '#0090ff' } }],
      [2, { user: { name: 'Claude (agent)', color: '#30a46c', agent: true } }],
      [3, { user: { name: 'Grace Hopper (agent)', color: '#e5484d' } }],
    ]);
    const peers = peersFromAwareness(states, 1, 'u1');
    const claude = peers.find(p => p.name === 'Claude');
    expect(claude).toMatchObject({ agent: true, self: false });
    expect(initialsOf(claude!.name)).toBe('C');
    expect(peerLabel(claude!)).toBe('Claude (agent)');
    // The suffix alone marks an agent too.
    expect(peers.find(p => p.name === 'Grace Hopper')?.agent).toBe(true);
    expect(peers.find(p => p.name === 'Ada Lovelace')).toMatchObject({ agent: false, self: true });
    expect(peerLabel(peers[0])).toBe('Ada Lovelace (you)');
  });

  test('initials never include punctuation', () => {
    expect(initialsOf('Claude (agent)')).toBe('C');
    expect(initialsOf('Ada (Countess) Lovelace')).toBe('AL');
    expect(initialsOf('(agent)')).toBe('A');
  });
});

test.describe('messages from the room', () => {
  test('checkpoint and page-meta parse; anything else is ignored', () => {
    expect(
      parseStatelessMessage(
        JSON.stringify({ type: 'checkpoint', at: '2026-10-03T10:00:00Z', commit: 'abc1234def' })
      )
    ).toEqual({ type: 'checkpoint', at: '2026-10-03T10:00:00Z', commit: 'abc1234def' });
    expect(
      parseStatelessMessage({ type: 'checkpoint', at: '2026-10-03T10:00:00Z', error: 'refused' })
    ).toEqual({ type: 'checkpoint', at: '2026-10-03T10:00:00Z', error: 'refused' });
    expect(parseStatelessMessage('{"type":"page-meta","title":"Week 2","width":3}')).toEqual({
      type: 'page-meta',
      title: 'Week 2',
      width: 3,
    });
    expect(parseStatelessMessage('{"type":"preview-changed"}')).toEqual({
      type: 'preview-changed',
    });
    // The Save version requests a run answers, and "nothing to save"; junk ids dropped.
    expect(
      parseStatelessMessage({
        type: 'checkpoint',
        at: '2026-10-03T10:00:00Z',
        requestIds: ['req-aaaaaaaa', 'bad id', 7],
        alreadySaved: true,
      })
    ).toEqual({
      type: 'checkpoint',
      at: '2026-10-03T10:00:00Z',
      requestIds: ['req-aaaaaaaa'],
      alreadySaved: true,
    });
    expect(
      parseStatelessMessage({ type: 'checkpoint', at: '2026-10-03T10:00:00Z', requestIds: 'x' })
    ).toEqual({ type: 'checkpoint', at: '2026-10-03T10:00:00Z' });
    expect(parseStatelessMessage('{"type":"checkpoint"}')).toBeNull();
    expect(parseStatelessMessage('{"type":"page-meta"}')).toBeNull();
    expect(parseStatelessMessage('{"type":"deck-meta","title":"x"}')).toBeNull();
    expect(parseStatelessMessage('not json')).toBeNull();
  });

  test('a title/width message applies over the loader, field by field', () => {
    const loaded = { title: 'Syllabus', width: 2 };
    expect(applyPageMeta(loaded, null)).toEqual(loaded);
    expect(applyPageMeta(loaded, { title: 'Course syllabus' })).toEqual({
      title: 'Course syllabus',
      width: 2,
    });
    expect(applyPageMeta(loaded, { width: 4 })).toEqual({ title: 'Syllabus', width: 4 });
    expect(applyPageMeta(loaded, { title: '   ' })).toEqual(loaded);
  });
});

test.describe('saved to GitHub', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');

  test('relative times', () => {
    expect(relativeTimeFrom('2026-10-03T11:59:40Z', now)).toBe('just now');
    expect(relativeTimeFrom('2026-10-03T11:58:00Z', now)).toBe('2 minutes ago');
    expect(relativeTimeFrom('2026-10-03T11:00:00Z', now)).toBe('1 hour ago');
    expect(relativeTimeFrom('2026-10-01T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTimeFrom('nonsense', now)).toBe('');
  });

  test('saved: when, with the commit on hover', () => {
    expect(
      savedToGitHubStatus({ at: '2026-10-03T11:55:00Z', commit: '0123456789abcdef' }, now)
    ).toEqual({
      tone: 'saved',
      label: 'Saved to GitHub 5 minutes ago',
      title: 'Commit 0123456',
      editsSince: false,
    });
  });

  test('edits since the checkpoint are said, and announced without the time', () => {
    const status = savedToGitHubStatus({ at: '2026-10-03T11:55:00Z' }, now, true);
    expect(status?.label).toBe('Saved to GitHub 5 minutes ago · edits since');
    expect(status?.editsSince).toBe(true);
    expect(savedToGitHubAnnouncement(status)).toBe('Edits since the last save to GitHub');
    const clean = savedToGitHubStatus({ at: '2026-10-03T11:55:00Z' }, now);
    const later = savedToGitHubStatus({ at: '2026-10-03T11:55:00Z' }, now + 30 * 60_000);
    // The visible line follows the clock; the announcement does not.
    expect(clean?.label).not.toBe(later?.label);
    expect(savedToGitHubAnnouncement(clean)).toBe(savedToGitHubAnnouncement(later));
    expect(savedToGitHubAnnouncement(clean)).toBe('Saved to GitHub');
    // A failed run is never "saved with edits since".
    const failed = savedToGitHubStatus({ at: '2026-10-03T11:55:00Z', error: 'refused' }, now, true);
    expect(failed?.editsSince).toBe(false);
    expect(savedToGitHubAnnouncement(failed)).toBe('Not saved to GitHub yet');
    expect(savedToGitHubAnnouncement(null)).toBe('');
  });

  test('not saved: a short reason on hover; nothing known: nothing shown', () => {
    const status = savedToGitHubStatus(
      { at: '2026-10-03T11:55:00Z', error: `push refused: ${'x'.repeat(300)}` },
      now
    );
    expect(status?.tone).toBe('unsaved');
    expect(status?.label).toBe('Not saved to GitHub yet');
    expect(status?.title?.length).toBeLessThanOrEqual(120);
    expect(savedToGitHubStatus(null, now)).toBeNull();
  });

  test('Save version is answered only by a checkpoint after it was accepted', () => {
    const accepted = Date.parse('2026-10-03T12:00:00Z');
    expect(checkpointAnswersSaveVersion({ at: '2026-10-03T12:00:05Z' }, accepted)).toBe(true);
    // A little clock skew between this browser and the worker is allowed.
    expect(checkpointAnswersSaveVersion({ at: '2026-10-03T11:59:50Z' }, accepted)).toBe(true);
    expect(checkpointAnswersSaveVersion({ at: '2026-10-03T11:50:00Z' }, accepted)).toBe(false);
    expect(checkpointAnswersSaveVersion({ at: '2026-10-03T12:00:05Z' }, null)).toBe(false);
    expect(SAVE_VERSION_WAIT_MS).toBe(60_000);
  });

  test('Save version is answered by the message naming its request, not by time', () => {
    const since = Date.parse('2026-10-03T12:00:00Z');
    const pending = { id: 'req-aaaaaaaa', since };
    // A routine run landing just after the click does not answer it.
    expect(saveVersionOutcome({ at: '2026-10-03T12:00:05Z' }, pending)).toBeNull();
    expect(
      saveVersionOutcome({ at: '2026-10-03T12:00:05Z', requestIds: ['req-bbbbbbbb'] }, pending)
    ).toBeNull();
    expect(
      saveVersionOutcome({ at: '2026-10-03T12:00:05Z', requestIds: ['req-aaaaaaaa'] }, pending)
    ).toBe('saved');
    expect(
      saveVersionOutcome(
        { at: '2026-10-03T12:00:05Z', requestIds: ['req-aaaaaaaa'], alreadySaved: true },
        pending
      )
    ).toBe('already-saved');
    expect(
      saveVersionOutcome(
        { at: '2026-10-03T12:00:05Z', requestIds: ['req-aaaaaaaa'], error: 'push refused' },
        pending
      )
    ).toBe('failed');
    expect(saveVersionOutcome({ at: '2026-10-03T12:00:05Z' }, null)).toBeNull();
    // A server that echoes no id: matched by time, as before.
    expect(saveVersionOutcome({ at: '2026-10-03T12:00:05Z' }, { id: null, since })).toBe('saved');
    expect(saveVersionOutcome({ at: '2026-10-03T11:50:00Z' }, { id: null, since })).toBeNull();
    expect(SAVE_VERSION_MESSAGES['already-saved']).toBe('Already saved.');
    expect(SAVE_VERSION_MESSAGES.saved).toBe('Version saved.');
  });

  test('request ids: generated ids pass the server check, junk does not', () => {
    const id = newSaveVersionRequestId();
    expect(isSaveVersionRequestId(id)).toBe(true);
    expect(newSaveVersionRequestId()).not.toBe(id);
    for (const bad of ['', 'short', 'x'.repeat(65), 'has space1', '<script>1', 42, null]) {
      expect(isSaveVersionRequestId(bad)).toBe(false);
    }
  });

  test('Save version waits for this browser to sync, and not offline', () => {
    expect(saveVersionGate('synced')).toBe('now');
    expect(saveVersionGate('syncing')).toBe('wait');
    expect(saveVersionGate('offline')).toBe('offline');
  });
});

test('copying unsaved edits is offered only when there are some to lose', () => {
  expect(offerCopyUnsaved({ refused: true, hasSynced: true, localUnsynced: true })).toBe(true);
  expect(offerCopyUnsaved({ refused: true, hasSynced: true, localUnsynced: false })).toBe(false);
  expect(offerCopyUnsaved({ refused: true, hasSynced: false, localUnsynced: true })).toBe(false);
  expect(offerCopyUnsaved({ refused: false, hasSynced: true, localUnsynced: true })).toBe(false);
});

test.describe('live editing on but unreachable', () => {
  test('read-only only while unsaved live edits exist', () => {
    expect(liveEditingBlocked({ flagged: true, envAvailable: false, bufferDirty: true })).toBe(
      true
    );
    expect(liveEditingBlocked({ flagged: true, envAvailable: false, bufferDirty: false })).toBe(
      false
    );
    expect(liveEditingBlocked({ flagged: true, envAvailable: true, bufferDirty: true })).toBe(
      false
    );
    expect(liveEditingBlocked({ flagged: false, envAvailable: false, bufferDirty: true })).toBe(
      false
    );
  });

  test('git writes are refused with a sentence, other intents carry on', () => {
    // preview-accept too: without the live service it would merge into git's copy.
    for (const intent of ['save', 'set-header-image', 'upload-header-image', 'preview-accept']) {
      expect(liveIntentRefusal(intent, false, true)).toEqual({
        status: 409,
        body: { error: LIVE_UNAVAILABLE_MESSAGE },
      });
    }
    expect(liveIntentRefusal('update-title', false, true)).toBeNull();
    expect(liveIntentRefusal('preview-discard', false, true)).toBeNull();
    expect(liveIntentRefusal('save', false, false)).toBeNull();
    expect(liveIntentRefusal('preview-accept', false, false)).toBeNull();
  });
});

test('the live route refreshes on preview-changed and on returning to view, never on a timer', () => {
  expect(ROUTE).toContain('if (liveMode && previewChangedSeq > 0) refreshLoader();');
  expect(ROUTE).toContain("document.addEventListener('visibilitychange', onVisible);");
  expect(ROUTE).not.toMatch(/setInterval\(refresh/);
});

test.describe('Save version note', () => {
  test('trimmed, one line, capped; empty is no note', () => {
    expect(versionNote('  Week 3 readings  ')).toBe('Week 3 readings');
    expect(versionNote('line one\nline two')).toBe('line one line two');
    expect(versionNote('x'.repeat(500))).toHaveLength(VERSION_NOTE_MAX);
    expect(versionNote('   ')).toBeUndefined();
    expect(versionNote(undefined)).toBeUndefined();
    expect(versionNote(42)).toBeUndefined();
  });

  test('the header asks through the note popover; Cmd-S saves without a note', () => {
    expect(ROUTE).toContain('if (canSaveVersion && !savingVersion) handleSaveVersion();');
    const header = readFileSync(
      fileURLToPath(
        new URL('../../app/components/editor/collab/LiveHeaderControls.tsx', import.meta.url)
      ),
      'utf8'
    );
    expect(header).toContain('<SaveVersionPopover');
    const popover = readFileSync(
      fileURLToPath(
        new URL('../../app/components/editor/collab/SaveVersionPopover.tsx', import.meta.url)
      ),
      'utf8'
    );
    expect(popover).toContain('maxLength={VERSION_NOTE_MAX}');
    expect(popover).toContain('export const VERSION_NOTE_MAX = 200;');
  });
});

test.describe('saved to GitHub before checkpoint times were recorded', () => {
  const row = (over: Partial<Parameters<typeof initialCheckpoint>[0]['row'] & object> = {}) => ({
    version: 4,
    pushed_version: 4,
    pushed_commit: 'abcdef1234567',
    source_sha: 'blob',
    ...over,
  });

  test('a clean page in git reads "Saved to GitHub" with no time', () => {
    const checkpoint = initialCheckpoint({
      lastCheckpointAt: null,
      lastCheckpointError: null,
      row: row(),
    });
    expect(checkpoint).toEqual({ at: null, commit: 'abcdef1234567' });
    expect(savedToGitHubStatus(checkpoint, Date.now())).toEqual({
      tone: 'saved',
      label: 'Saved to GitHub',
      title: 'Commit abcdef1',
      editsSince: false,
    });
    // Seeded from git, never pushed by live editing: saved, no commit known.
    const seeded = initialCheckpoint({
      lastCheckpointAt: null,
      lastCheckpointError: null,
      row: row({ version: 0, pushed_version: 0, pushed_commit: null }),
    });
    expect(savedToGitHubStatus(seeded, Date.now())).toEqual({
      tone: 'saved',
      label: 'Saved to GitHub',
      title: undefined,
      editsSince: false,
    });
  });

  test('nothing for unsaved live edits, a page with no git history, or no row', () => {
    for (const r of [row({ version: 5 }), row({ pushed_commit: null, source_sha: null }), null]) {
      expect(
        initialCheckpoint({ lastCheckpointAt: null, lastCheckpointError: null, row: r })
      ).toBeNull();
    }
  });

  test('a recorded checkpoint wins, with its error and the last commit', () => {
    expect(
      initialCheckpoint({
        lastCheckpointAt: '2026-10-03T12:00:00Z',
        lastCheckpointError: 'push refused',
        row: row(),
      })
    ).toEqual({ at: '2026-10-03T12:00:00Z', commit: 'abcdef1234567', error: 'push refused' });
  });

  test('a recorded checkpoint with live edits after it says so', () => {
    expect(
      initialCheckpoint({
        lastCheckpointAt: '2026-10-03T12:00:00Z',
        lastCheckpointError: null,
        row: row({ version: 6 }),
      })
    ).toEqual({ at: '2026-10-03T12:00:00Z', commit: 'abcdef1234567', editsSince: true });
  });

  test('a time-less checkpoint never answers a pending Save version', () => {
    expect(checkpointAnswersSaveVersion({ at: null }, Date.now())).toBe(false);
  });
});
