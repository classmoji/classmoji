/**
 * The signing invariant: a sha is signed for a classroom ONLY when that
 * classroom's asset map holds it.
 *
 * ## Why this is the control that matters
 *
 * The Worker caches blobs by CONTENT — `blobs/{sha}` in R2, one object shared
 * by every classroom holding the same bytes — and it does not know, and must
 * not have to know, which files a classroom owns. The signature is the entire
 * proof of entitlement. So a signature over a sha outside the classroom's map
 * is not a Worker bug: it is a correctly verified claim the app should never
 * have made, and it is the one thing that would let classroom A read classroom
 * B's cached private bytes.
 *
 * Everything below is therefore about the MINT, not the cache:
 *
 *   - a sha the map has never heard of is refused on every path that carries
 *     one in from outside (a commit response, a pasted URL, a task payload);
 *   - a row genuinely read from classroom B, handed to a mint for classroom A,
 *     is refused — at the type level a caller cannot even build one by hand,
 *     and at runtime the classroom the row came from is asserted;
 *   - a refusal degrades exactly as a missing row already does (the stored ref,
 *     a `/missing/` placeholder, a legacy URL) and never throws;
 *   - a pasted signed URL whose sha has left the map canonicalizes to the
 *     stored string rather than being re-signed.
 *
 * The map is in memory and holds TWO classrooms, because half of what is being
 * asserted is that one classroom's rows never answer for the other.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
// Type-only: erased at compile time, so it does not defeat the module mock below.
import type { MappedAsset } from '../contentDelivery.service.ts';

/** The signer refuses anything that is not a lowercase UUID. */
const CLASSROOM_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CLASSROOM_B = '9c858901-8a57-4791-81fe-4c455b099bc9';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
/** A well-formed sha no classroom's map has ever held. */
const SHA_ORPHAN = 'c'.repeat(40);
const TREE_SHA = 'd'.repeat(40);

const REPO_PATH = 'pages/lab-1/assets/hero.png';
const THEMES_FOLDER = '.slidesthemes';

interface Row {
  path: string;
  sha: string;
  type: string;
  size: number;
}

/** `classroomId → path → row`. Two classrooms, deliberately. */
const map = new Map<string, Map<string, Row>>();

function setRows(classroomId: string, rows: Row[]): void {
  map.set(classroomId, new Map(rows.map(row => [row.path, row])));
}

function rowsOf(classroomId: string): Map<string, Row> {
  return map.get(classroomId) ?? new Map();
}

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const uploadMock = vi.fn();
const recordContentAssetMock = vi.fn();

vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    upload: (...args: unknown[]) => uploadMock(...args),
    getContent: vi.fn(),
    getMeta: vi.fn(),
    uploadBatch: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('../contentAssets.service.ts', () => ({
  ensureContentAssets: async () => null,
  resolveContentBranch: async () => 'main',
  recordContentAsset: (...args: unknown[]) => recordContentAssetMock(...args),
  recordContentAssets: async () => true,

  lookupContentAsset: async (classroomId: string, path: string) => {
    const row = rowsOf(classroomId).get(path);
    return row ? { sha: row.sha, type: row.type, size: row.size } : null;
  },

  lookupContentAssets: async (classroomId: string, paths: string[]) =>
    new Map(
      paths.flatMap(path => {
        const row = rowsOf(classroomId).get(path);
        return row ? [[path, { sha: row.sha, type: row.type, size: row.size }] as const] : [];
      })
    ),

  lookupContentTree: async (classroomId: string, dirPath: string) => {
    const row = rowsOf(classroomId).get(dirPath.replace(/\/+$/, ''));
    return row && row.type === 'tree' ? { sha: row.sha, type: row.type, size: row.size } : null;
  },

  lookupContentAssetBySha: async (classroomId: string, sha: string) => {
    for (const row of rowsOf(classroomId).values()) {
      if (row.sha === sha) return { path: row.path, type: row.type, size: row.size };
    }
    return null;
  },

  // Honours the `type` filter, because the guard depends on it: a tree sha is
  // 40 hex characters like any other and must not answer a blob lookup.
  lookupContentAssetsBySha: async (
    classroomId: string,
    shas: string[],
    opts: { type?: string } = {}
  ) => {
    const wanted = new Set(shas);
    const bySha = new Map<string, string>();
    for (const row of [...rowsOf(classroomId).values()].sort((a, b) =>
      a.path.localeCompare(b.path)
    )) {
      if (!wanted.has(row.sha)) continue;
      if (opts.type && row.type !== opts.type) continue;
      if (!bySha.has(row.sha)) bySha.set(row.sha, row.path);
    }
    return bySha;
  },
}));

const {
  canonicalizeAssetRef,
  mappedAssetsBySha,
  resolveAssetSrcSet,
  resolveAssetUrl,
  resolveDelivery,
  resolveThemeBase,
  signBlobUrlForClassroom,
  warmContentBlob,
  warmContentText,
} = await import('../contentDelivery.service.ts');

const { uploadPageAsset } = await import('../pageContent.service.ts');

const ORIGIN = 'https://cdn.classmoji.test';
const MASTER = 'test-master-secret';

function classroomRow(id: string, org: string, repo: string) {
  return {
    id,
    content_key_version: 7,
    content_repo: repo,
    content_delivery_enabled: true,
    git_organization: { login: org },
  };
}

const ctxA = { classroom: classroomRow(CLASSROOM_A, 'org-a', 'content-a'), tier: 'week' as const };
const ctxB = { classroom: classroomRow(CLASSROOM_B, 'org-b', 'content-b'), tier: 'week' as const };

/** The one line an operator is told to search for. */
const REFUSAL = '[contentDelivery] refused to sign sha outside classroom map';

let warnSpy: MockInstance<typeof console.warn>;
let fetchSpy: MockInstance<typeof fetch>;

function refusals(): string[] {
  return warnSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('refused to sign sha outside classroom map'));
}

beforeEach(() => {
  process.env.CONTENT_DELIVERY_ORIGIN = ORIGIN;
  process.env.CONTENT_SIGNING_SECRET = MASTER;

  map.clear();
  setRows(CLASSROOM_A, [
    { path: REPO_PATH, sha: SHA_A, type: 'blob', size: 10 },
    { path: `${THEMES_FOLDER}/cosmo`, sha: TREE_SHA, type: 'tree', size: 0 },
  ]);
  // The SAME path, a DIFFERENT sha. Classroom A must never sign B's.
  setRows(CLASSROOM_B, [{ path: REPO_PATH, sha: SHA_B, type: 'blob', size: 10 }]);

  uploadMock.mockReset();
  recordContentAssetMock.mockReset().mockResolvedValue(true);

  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('ok', { status: 200 }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  delete process.env.CONTENT_SIGNING_SECRET;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('proof of map membership', () => {
  it('hands back no proof for a sha the map has never held, and says so', async () => {
    const proofs = await mappedAssetsBySha(CLASSROOM_A, [SHA_ORPHAN]);

    expect(proofs.size).toBe(0);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain(REFUSAL);
    expect(refusals()[0]).toContain(CLASSROOM_A);
    expect(refusals()[0]).toContain(SHA_ORPHAN);
  });

  it('never names the signing secret in a refusal', async () => {
    await mappedAssetsBySha(CLASSROOM_A, [SHA_ORPHAN]);

    for (const line of warnSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call))) {
      expect(line).not.toContain(MASTER);
    }
  });

  it('refuses a sha that is in ANOTHER classroom’s map but not this one', async () => {
    // SHA_B is a real row — in classroom B. Asking classroom A for it is
    // exactly the cross-classroom read the Worker cannot distinguish.
    const proofs = await mappedAssetsBySha(CLASSROOM_A, [SHA_B]);

    expect(proofs.size).toBe(0);
    expect(refusals()[0]).toContain(SHA_B);
  });

  it('refuses a TREE sha asked for as a blob', async () => {
    const proofs = await mappedAssetsBySha(CLASSROOM_A, [TREE_SHA]);

    expect(proofs.size).toBe(0);
    expect(refusals()[0]).toContain(TREE_SHA);
  });

  it('folds repeat refusals for one sha into a single line per render', async () => {
    await Promise.all([
      mappedAssetsBySha(CLASSROOM_A, [SHA_ORPHAN]),
      mappedAssetsBySha(CLASSROOM_A, [SHA_ORPHAN]),
      mappedAssetsBySha(CLASSROOM_A, [SHA_ORPHAN]),
    ]);

    expect(refusals()).toHaveLength(1);
  });
});

describe('the choke point', () => {
  it('refuses a row from classroom B handed to a mint for classroom A', async () => {
    const proof = (await mappedAssetsBySha(CLASSROOM_B, [SHA_B])).get(SHA_B);
    expect(proof).toBeDefined();

    const url = await signBlobUrlForClassroom(
      { id: CLASSROOM_A, content_key_version: 7 },
      { origin: ORIGIN, master: MASTER },
      { asset: proof as MappedAsset, ext: 'png', tier: 'week' }
    );

    expect(url).toBeNull();
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain(`classroom=${CLASSROOM_A}`);
    expect(refusals()[0]).toContain(`sha=${SHA_B}`);
    expect(refusals()[0]).toContain(CLASSROOM_B);
  });

  it('signs the same row for the classroom it was actually read for', async () => {
    const proof = (await mappedAssetsBySha(CLASSROOM_B, [SHA_B])).get(SHA_B);

    const url = await signBlobUrlForClassroom(
      { id: CLASSROOM_B, content_key_version: 7 },
      { origin: ORIGIN, master: MASTER },
      { asset: proof as MappedAsset, ext: 'png', tier: 'week' }
    );

    expect(url).toContain(`/c/${CLASSROOM_B}/blob/${SHA_B}.png`);
    expect(refusals()).toHaveLength(0);
  });

  it('will not take a hand-built asset — the brand is nominal, and that is the point', async () => {
    // The brand is NOMINAL, not unforgeable: `as unknown as MappedAsset` would
    // get past it. What it buys is that passing a bare sha stops being possible
    // by accident and becomes a cast somebody has to write and a reviewer can
    // see. The wall that actually holds is the runtime `classroom_id` check
    // above, which a cast cannot satisfy without naming a classroom; the second
    // wall is the `no-restricted-imports` rule in the shared eslint config,
    // which stops a module skipping this function entirely by importing
    // `@classmoji/content-signing` and calling `signBlobUrl` itself.
    //
    // This assertion is live: if the brand ever stopped rejecting a plain
    // object, `tsc --noEmit` would fail the directive as unused.
    await signBlobUrlForClassroom(
      { id: CLASSROOM_A, content_key_version: 7 },
      { origin: ORIGIN, master: MASTER },
      {
        // @ts-expect-error a bare sha is not proof of anything — the ordinary
        // way to get a MappedAsset is to read a row out of a classroom's map.
        asset: { classroom_id: CLASSROOM_A, path: REPO_PATH, sha: SHA_ORPHAN, type: 'blob' },
        ext: 'png',
        tier: 'week',
      }
    );
  });

  it('refuses a FORGED row even when the cast gets past the brand', async () => {
    // The cast the brand cannot stop, made explicitly. A caller determined
    // enough to write this still has to name a classroom on the row, and naming
    // the wrong one is exactly what `mintSigned` refuses.
    const forged = {
      classroom_id: CLASSROOM_B,
      path: REPO_PATH,
      sha: SHA_ORPHAN,
      type: 'blob',
    } as unknown as MappedAsset;

    const url = await signBlobUrlForClassroom(
      { id: CLASSROOM_A, content_key_version: 7 },
      { origin: ORIGIN, master: MASTER },
      { asset: forged, ext: 'png', tier: 'week' }
    );

    expect(url).toBeNull();
    expect(refusals()[0]).toContain(SHA_ORPHAN);
  });
});

describe('resolvers stay scoped to their own classroom', () => {
  it('signs classroom A’s sha, never classroom B’s, for the same path', async () => {
    const fromA = await resolveAssetUrl(ctxA, REPO_PATH);
    const fromB = await resolveAssetUrl(ctxB, REPO_PATH);

    expect(fromA).toContain(`/c/${CLASSROOM_A}/blob/${SHA_A}.png`);
    expect(fromB).toContain(`/c/${CLASSROOM_B}/blob/${SHA_B}.png`);
    expect(fromA).not.toContain(SHA_B);
    expect(fromB).not.toContain(SHA_A);
  });

  it('placeholders a path this classroom has no row for', async () => {
    setRows(CLASSROOM_A, []);

    const url = await resolveAssetUrl(ctxA, REPO_PATH);

    expect(url).toBe(`${ORIGIN}/c/${CLASSROOM_A}/missing/${encodeURIComponent(REPO_PATH)}`);
    expect(url).not.toContain(SHA_B);
  });

  it('emits no srcset — and no signature — for a path with no row', async () => {
    setRows(CLASSROOM_A, []);

    expect(await resolveAssetSrcSet(ctxA, REPO_PATH)).toBeNull();
  });

  it('signs a theme folder only from this classroom’s own tree row', async () => {
    const base = await resolveThemeBase(ctxA, 'cosmo');
    expect(base).toContain(`/c/${CLASSROOM_A}/theme/cosmo/${TREE_SHA}/`);

    // Classroom B has no `.slidesthemes/cosmo` row at all.
    expect(await resolveThemeBase(ctxB, 'cosmo')).toBeNull();
  });

  it('refuses to sign a theme folder from a BLOB row at the theme path', async () => {
    setRows(CLASSROOM_A, [{ path: `${THEMES_FOLDER}/cosmo`, sha: SHA_A, type: 'blob', size: 10 }]);

    expect(await resolveThemeBase(ctxA, 'cosmo')).toBeNull();
  });
});

describe('server-to-server mints', () => {
  it('warms nothing when the map has no row for the path', async () => {
    setRows(CLASSROOM_A, []);

    await warmContentText({ classroom: ctxA.classroom }, ['content.json']);
    await warmContentBlob({ classroom: ctxA.classroom }, ['pages/lab-1/thumbnail.webp']);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warms at classroom A’s own sha, never a same-path row from B', async () => {
    await warmContentBlob({ classroom: ctxA.classroom }, [REPO_PATH]);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain(`/c/${CLASSROOM_A}/blob/${SHA_A}.png`);
    expect(url).not.toContain(SHA_B);
  });
});

describe('the upload path — the one sha carried in from outside the map', () => {
  const page = {
    id: 'page-1',
    title: 'Lab 1',
    content_path: 'pages/lab-1',
    classroom: {
      ...classroomRow(CLASSROOM_A, 'org-a', 'content-a'),
      git_organization: { login: 'org-a', id: 'org-a-id' },
    },
  };

  beforeEach(() => {
    uploadMock.mockResolvedValue({
      path: `${page.content_path}/assets/new.png`,
      sha: SHA_ORPHAN,
      url: `https://raw.githubusercontent.com/org-a/content-a/main/${page.content_path}/assets/new.png`,
    });
  });

  it('signs the upload once its row is in the map', async () => {
    recordContentAssetMock.mockImplementation(async (classroomId: string, entry: Row) => {
      rowsOf(classroomId).set(entry.path, { ...entry, type: 'blob', size: 0 });
      map.set(classroomId, rowsOf(classroomId));
      return true;
    });

    const result = await uploadPageAsset(
      page as unknown as Parameters<typeof uploadPageAsset>[0],
      Buffer.from('bytes'),
      'new.png'
    );

    expect(result.displayUrl).toContain(`/c/${CLASSROOM_A}/blob/${SHA_ORPHAN}.png`);
    // A signable upload stores the repo PATH, which keeps following the file.
    expect(result.url).toBe(`${page.content_path}/assets/new.png`);
    expect(refusals()).toHaveLength(0);
  });

  it('refuses, and stores the legacy URL, when the row was never written', async () => {
    // `recordContentAsset` declines for a classroom the delivery layer cannot
    // serve — a non-GitHub provider, no content repo — and it can simply fail.
    // Before the guard this still minted a signature, and `uploadPageAsset`
    // then stored a bare repo path no reader could ever resolve.
    recordContentAssetMock.mockResolvedValue(false);

    const result = await uploadPageAsset(
      page as unknown as Parameters<typeof uploadPageAsset>[0],
      Buffer.from('bytes'),
      'new.png'
    );

    expect(result.displayUrl).toBeNull();
    expect(result.url).toBe(
      `https://raw.githubusercontent.com/org-a/content-a/main/${page.content_path}/assets/new.png`
    );
    expect(refusals()[0]).toContain(SHA_ORPHAN);
  });
});

describe('a pasted signed URL is never re-signed', () => {
  it('canonicalizes to the stored ref when the sha has left the map', async () => {
    const signed = await resolveAssetUrl(ctxA, REPO_PATH);
    expect(signed).toContain(SHA_A);

    // The file is deleted, or the map re-synced mid-edit.
    setRows(CLASSROOM_A, []);

    const stored = await canonicalizeAssetRef(ctxA, signed);

    // The caller's own string, unchanged — there is no path to store instead,
    // and inventing one would silently retarget the reference.
    expect(stored).toBe(signed);

    // And re-rendering it mints nothing: it is not a repo path, so it passes
    // straight through rather than becoming a fresh signature over a sha the
    // map no longer holds.
    const { urls } = await resolveDelivery(ctxA, [stored]);
    expect(urls.get(stored)).toBe(stored);
  });

  it('leaves another classroom’s signed URL alone rather than resolving it here', async () => {
    const foreign = await resolveAssetUrl(ctxB, REPO_PATH);
    expect(foreign).toContain(CLASSROOM_B);

    expect(await canonicalizeAssetRef(ctxA, foreign)).toBe(foreign);
  });

  it('undoes a signed URL to its repo path while the sha is still mapped', async () => {
    const signed = await resolveAssetUrl(ctxA, REPO_PATH);

    expect(await canonicalizeAssetRef(ctxA, signed)).toBe(REPO_PATH);
  });
});
