/**
 * Live editing in the pages app: the collab loader data, the env it is built
 * from, the internal API client, and the gate that switches the git save
 * machinery off for a live page.
 *
 * Pure modules are called directly; the wiring inside the route component and
 * the action (which need a router and a database) is read from source, the
 * approach `cover-upload.spec.ts` takes.
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
  claimStaleReload,
  deriveSyncStatus,
  initialsOf,
  isCollabMode,
  normalizeRejectReason,
  peersFromAwareness,
  readCoverValue,
  rejectionNotice,
  saveMachineryEnabled,
  type CollabLoaderData,
} from '../../app/utils/collab.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const ROUTE = source('../../app/routes/$classroomSlug.$pageId/route.tsx');
const ROUTE_SERVER = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');

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

  test('the WebSocket URL is derived from COLLAB_URL when it is not set', () => {
    expect(
      collabEnv({
        NODE_ENV: 'production',
        COLLAB_URL: 'https://collab.classmoji.io',
        COLLAB_INTERNAL_SECRET: 's',
      })?.wsUrl
    ).toBe('wss://collab.classmoji.io');
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

  test('every save path in the route is gated on saveEnabled, not canEdit', () => {
    // Explicit save, change tracking, Cmd-S, beforeunload.
    expect(ROUTE).toContain('if (!saveEnabled || !editorRef.current) return;');
    expect(ROUTE).toMatch(
      /handleEditorChange = useCallback\(\s*\(document: unknown\) => \{\s*if \(!saveEnabled\) return;/
    );
    expect(ROUTE).toMatch(
      /Cmd\/Ctrl\+S[^\n]*\n\s*useEffect\(\(\) => \{\s*if \(!saveEnabled\) return;/
    );
    expect(ROUTE).toMatch(
      /Warn before closing[^\n]*\n\s*useEffect\(\(\) => \{\s*if \(!saveEnabled\) return;/
    );
    // The save chooser, the conflict banner and the header's Save button.
    expect(ROUTE).toContain('{saveEnabled && saveMergeReport && (');
    expect(ROUTE).toContain('{saveEnabled && saveConflict && (');
    expect(ROUTE).toContain('onSave={saveEnabled ? handleSave : undefined}');
    // Merged-document adoption after an accept is skipped live.
    expect(ROUTE).toContain('if (!liveMode && !hasUnsavedChanges) {');
  });

  test('the live editor never gets initialContent and is keyed on the room', () => {
    const live = ROUTE.slice(
      ROUTE.indexOf('/* Live editor'),
      ROUTE.indexOf('/* Editor for instructors')
    );
    expect(live).toContain('key={collab.room}');
    expect(live).toContain('initialContent={null}');
    expect(live).toContain('liveState.hasSynced');
    expect(live).not.toContain('onChange=');
  });

  test('the action refuses every git write for a live classroom', () => {
    expect(ROUTE_SERVER).toContain("if (liveEnv && intent === 'save') {");
    expect(ROUTE_SERVER).toContain('if (liveEnv && LIVE_REFUSED_COVER_INTENTS.has(intent)) {');
    expect(ROUTE_SERVER).toContain(
      "LIVE_REFUSED_COVER_INTENTS = new Set(['set-header-image', 'upload-header-image'])"
    );
    expect(ROUTE_SERVER).toContain("if (liveEnv && intent === 'preview-accept') {");
    // The refusal of a save must not carry a `code`, or the client's
    // whole-document fallback would resubmit it.
    const refusal = ROUTE_SERVER.slice(
      ROUTE_SERVER.indexOf("if (liveEnv && intent === 'save') {"),
      ROUTE_SERVER.indexOf('if (liveEnv && LIVE_REFUSED_COVER_INTENTS.has(intent)) {')
    );
    expect(refusal).toContain('conflict: true');
    expect(refusal).not.toMatch(/code:/);
  });

  test('a live editor is not handed content.json or a conflict token', () => {
    expect(ROUTE_SERVER).toContain('content: collab ? null : viewerContent,');
    expect(ROUTE_SERVER).toContain("!collab && format === 'json' ? contentFileSha : null");
  });
});

// ─── Connection state ────────────────────────────────────────────────────────

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
  });
});

test.describe('refusals', () => {
  test('our reasons pass through, anything else is forbidden', () => {
    expect(normalizeRejectReason('stale-epoch')).toBe('stale-epoch');
    expect(normalizeRejectReason('schema-mismatch')).toBe('schema-mismatch');
    expect(normalizeRejectReason('forbidden')).toBe('forbidden');
    expect(normalizeRejectReason('permission-denied')).toBe('forbidden');
    expect(normalizeRejectReason(undefined)).toBe('forbidden');
  });

  test('stale reloads, schema asks to reload, forbidden goes read-only', () => {
    expect(rejectionNotice('stale-epoch').action).toBe('reload');
    expect(rejectionNotice('schema-mismatch')).toEqual({
      action: 'prompt',
      message: 'Reload to get the latest editor.',
    });
    expect(rejectionNotice('forbidden').action).toBe('readonly');
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
