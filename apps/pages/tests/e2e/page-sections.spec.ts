/**
 * Page sections against the running dev stack: a student's payload never
 * holds a locked body they have not unlocked, and nobody reads anyone else's
 * checks, unlocks or unlock list.
 *
 * ── How the page content gets here ──────────────────────────────────────────
 * A reader's page loader reads `content.json` by sha through the content
 * delivery layer (`loadPageContent(..., { viaWorker: true })`): a
 * `content_assets` map row names the blob, and a signed URL on
 * `CONTENT_DELIVERY_ORIGIN` (http://localhost:8787 in dev) serves its bytes.
 * The seeded dev classroom's org (`dev-org`) and content repo do not exist on
 * GitHub, so this spec stands in for both halves: it seeds the map row for a
 * page it creates, stamps the classroom's map as freshly synced (so the read
 * never tries GitHub), and answers on :8787 itself with the fixture document
 * for that blob sha. Everything between — the loader, the redaction, the
 * service, the API route — is the real code.
 *
 * Staff who EDIT (owner/teacher) load the page from GitHub (fresh, for the save
 * token), which cannot work here; so the editor-side views are covered by the
 * unit suite, and this spec drives the reader views (students, the assistant,
 * anonymous) plus the staff unlock list (an API call, no content read).
 *
 * Requires the dev stack (`npm run dev`) with the seeded dev database, and
 * port 8787 free (no `wrangler dev` for apps/content running).
 */

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';

import { test, expect } from '../fixtures/test.fixture';
import {
  getClassroomIdBySlug,
  getPagesBaseURL,
  getTestClassroomSlug,
  getTestPrisma,
} from '../helpers';

test.describe.configure({ mode: 'serial' });

const CLASS_A_SLUG = getTestClassroomSlug();
const CLASS_B_SLUG = 'classmoji-other-class';
const WORKER_PORT = 8787;
/**
 * The pages server to drive. `PAGE_SECTIONS_BASE_URL` points the spec at a
 * second pages process when the stack's own one predates the Prisma client
 * that knows the page-section tables (a long-running dev server keeps the
 * client it loaded at start).
 */
const BASE_URL = process.env.PAGE_SECTIONS_BASE_URL || getPagesBaseURL();

const RUN = randomUUID().slice(0, 8);
const OUTER_SECRET = `OUTER-SECRET-${RUN}`;
const INNER_SECRET = `INNER-SECRET-${RUN}`;
const SOLO_SECRET = `SOLO-SECRET-${RUN}`;
const B_SECRET = `B-SECRET-${RUN}`;

const ID = {
  heading: randomUUID(),
  outer: randomUUID(),
  inner: randomUUID(),
  headingInOuter: randomUUID(),
  solo: randomUUID(),
  bLock: randomUUID(),
  bHeading: randomUUID(),
};

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

function documentA() {
  return {
    blocks: [
      {
        id: ID.heading,
        type: 'heading',
        props: { level: 2, checkable: true },
        content: text('Part one'),
        children: [],
      },
      { id: randomUUID(), type: 'paragraph', content: text('Public intro text'), children: [] },
      {
        id: randomUUID(),
        type: 'columnList',
        props: {},
        children: [
          {
            id: randomUUID(),
            type: 'column',
            props: { width: 1 },
            children: [
              {
                id: ID.outer,
                type: 'lockedSection',
                props: { title: 'Outer hint' },
                children: [
                  {
                    id: randomUUID(),
                    type: 'paragraph',
                    content: text(OUTER_SECRET),
                    children: [],
                  },
                  {
                    id: ID.headingInOuter,
                    type: 'heading',
                    props: { level: 3, checkable: true },
                    content: text('Hidden step'),
                    children: [],
                  },
                  {
                    id: ID.inner,
                    type: 'lockedSection',
                    props: { title: 'Inner hint' },
                    children: [
                      {
                        id: randomUUID(),
                        type: 'paragraph',
                        content: text(INNER_SECRET),
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: randomUUID(),
            type: 'column',
            props: { width: 1 },
            children: [
              {
                id: ID.solo,
                type: 'lockedSection',
                props: { title: 'Solo hint' },
                children: [
                  { id: randomUUID(), type: 'paragraph', content: text(SOLO_SECRET), children: [] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function documentB() {
  return {
    blocks: [
      {
        id: ID.bHeading,
        type: 'heading',
        props: { level: 2, checkable: true },
        content: text('B part'),
        children: [],
      },
      {
        id: ID.bLock,
        type: 'lockedSection',
        props: { title: 'B hint' },
        children: [{ id: randomUUID(), type: 'paragraph', content: text(B_SECRET), children: [] }],
      },
    ],
  };
}

interface Seeded {
  classroomId: string;
  slug: string;
  pageId: string;
  contentPath: string;
  sha: string;
  body: string;
  previousSyncedAt: Date | null;
}

let pageA: Seeded;
let pageB: Seeded;
let server: Server | null = null;
let serverError: string | null = null;
const blobsBySha = new Map<string, string>();
const userIds: Record<string, string> = {};

const gitBlobSha = (body: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(body)}\0${body}`)
    .digest('hex');

async function userIdFor(login: string): Promise<string> {
  if (userIds[login]) return userIds[login]!;
  const prisma = await getTestPrisma();
  const user = await prisma.user.findFirst({
    where: { accounts: { some: { provider_id: 'github', username: login } } },
    select: { id: true },
  });
  if (!user) throw new Error(`No seeded user '${login}'`);
  userIds[login] = user.id;
  return user.id;
}

async function seedPage(slug: string, doc: unknown, isPublic: boolean): Promise<Seeded> {
  const prisma = await getTestPrisma();
  const classroomId = await getClassroomIdBySlug(slug);
  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    select: { content_assets_synced_at: true },
  });
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, role: 'OWNER' },
    select: { user_id: true },
  });
  const pageSlug = `e2e-page-sections-${RUN}`;
  const contentPath = `pages/${pageSlug}`;
  const body = JSON.stringify(doc);
  const sha = gitBlobSha(body);
  const page = await prisma.page.create({
    data: {
      classroom_id: classroomId,
      title: `E2E page sections ${RUN}`,
      slug: pageSlug,
      content_path: contentPath,
      created_by: owner!.user_id,
      is_draft: false,
      is_public: isPublic,
    },
    select: { id: true },
  });
  await prisma.contentAsset.upsert({
    where: {
      classroom_id_path: { classroom_id: classroomId, path: `${contentPath}/content.json` },
    },
    create: {
      classroom_id: classroomId,
      path: `${contentPath}/content.json`,
      sha,
      type: 'blob',
      size: Buffer.byteLength(body),
      synced_at: new Date(),
    },
    update: { sha, type: 'blob', size: Buffer.byteLength(body), synced_at: new Date() },
  });
  // A fresh full-sync stamp: the read's map refresh then trusts the map and
  // never reaches for GitHub (which cannot answer for `dev-org`).
  await prisma.classroom.update({
    where: { id: classroomId },
    data: { content_assets_synced_at: new Date() },
  });
  blobsBySha.set(sha, body);
  return {
    classroomId,
    slug,
    pageId: page.id,
    contentPath,
    sha,
    body,
    previousSyncedAt: classroom?.content_assets_synced_at ?? null,
  };
}

async function startWorkerStub(): Promise<void> {
  server = createServer((req, res) => {
    const match = /\/blob\/([0-9a-f]{40})\.json/.exec(req.url ?? '');
    const body = match ? blobsBySha.get(match[1]!) : undefined;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>(resolve => {
    server!.once('error', error => {
      serverError = `port ${WORKER_PORT} is taken (${(error as Error).message}); stop wrangler dev`;
      server = null;
      resolve();
    });
    server!.listen(WORKER_PORT, '127.0.0.1', () => resolve());
  });
}

/**
 * A signed-in (or anonymous) HTTP client. Browserless on purpose: every
 * assertion here is about what the server sends, and a request context sees
 * exactly that. The session is minted the way `loginAsLogin` mints one (the
 * dev test-login fallback reads it); `impersonatedBy` makes it a platform
 * admin's view-as session.
 */
type Actor = { request: APIRequestContext };
const mintedTokens: string[] = [];
const contexts: APIRequestContext[] = [];
let page: Actor;

async function as(login?: string, impersonatedBy?: string): Promise<Actor> {
  let cookie: string | undefined;
  if (login) {
    const prisma = await getTestPrisma();
    const token = randomUUID();
    await prisma.session.create({
      data: {
        token,
        user_id: await userIdFor(login),
        ...(impersonatedBy ? { impersonatedBy: await userIdFor(impersonatedBy) } : {}),
        expires_at: new Date(Date.now() + 60 * 60 * 1000),
        ip_address: '127.0.0.1',
        user_agent: 'playwright',
      },
    });
    mintedTokens.push(token);
    cookie = `classmoji.session_token=${token}`;
  }
  const context = await apiRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: cookie ? { cookie } : {},
  });
  contexts.push(context);
  return { request: context };
}

const viewPath = (s: Seeded) => `/${s.slug}/${s.pageId}`;
const dataPath = (s: Seeded) => `${viewPath(s)}.data`;

async function loaderData(
  page: Actor,
  s: Seeded
): Promise<{ status: number; text: string; res: APIResponse }> {
  const res = await page.request.get(dataPath(s));
  return { status: res.status(), text: await res.text(), res };
}

/**
 * The page route's `readerSections`, decoded from the single-fetch payload.
 * React Router's turbo-stream is a flat JSON array: an object is
 * `{ "_<key index>": <value index> }`, strings are stored once and referenced.
 * Enough of a decoder for plain objects, arrays, strings, numbers and booleans.
 */
function readerSectionsOf(payload: string): Record<string, unknown> | null {
  const firstLine = payload.split('\n')[0] ?? '';
  let flat: unknown[];
  try {
    flat = JSON.parse(firstLine) as unknown[];
  } catch {
    return null;
  }
  const keyIndex = flat.indexOf('readerSections');
  if (keyIndex < 0) return null;
  const SPECIAL: Record<number, unknown> = {
    [-1]: undefined,
    [-5]: undefined,
    [-7]: null,
    [-3]: NaN,
  };
  const decode = (index: number, depth = 0): unknown => {
    if (index < 0) return SPECIAL[index];
    if (depth > 20) return undefined;
    const value = flat[index];
    if (Array.isArray(value)) return value.map(i => decode(i as number, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, number>)) {
        const key = flat[Number(k.slice(1))] as string;
        out[key] = decode(v, depth + 1);
      }
      return out;
    }
    return value;
  };
  for (const entry of flat) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const ref = (entry as Record<string, number>)[`_${keyIndex}`];
      if (typeof ref === 'number') return decode(ref) as Record<string, unknown>;
    }
  }
  return null;
}

async function sections(page: Actor, s: Seeded, body: Record<string, unknown>, headers = {}) {
  const res = await page.request.post('/api/page-sections', {
    data: body,
    headers: { 'content-type': 'application/json', ...headers },
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON
  }
  return { status: res.status(), json, headers: res.headers() };
}

async function unlockList(page: Actor, s: Seeded, blockId: string) {
  const res = await page.request.get(
    `/api/page-sections?pageId=${encodeURIComponent(s.pageId)}&blockId=${encodeURIComponent(blockId)}`
  );
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-JSON
  }
  return { status: res.status(), json };
}

test.beforeAll(async () => {
  await startWorkerStub();
  if (serverError) return;
  pageA = await seedPage(CLASS_A_SLUG, documentA(), true);
  pageB = await seedPage(CLASS_B_SLUG, documentB(), false);
});

test.afterAll(async () => {
  const prisma = await getTestPrisma();
  for (const seeded of [pageA, pageB]) {
    if (!seeded) continue;
    await prisma.page.deleteMany({ where: { id: seeded.pageId } }); // cascades section rows
    await prisma.contentAsset.deleteMany({
      where: { classroom_id: seeded.classroomId, path: `${seeded.contentPath}/content.json` },
    });
    await prisma.classroom.update({
      where: { id: seeded.classroomId },
      data: { content_assets_synced_at: seeded.previousSyncedAt },
    });
  }
  for (const context of contexts) await context.dispose();
  if (mintedTokens.length) {
    await prisma.session.deleteMany({ where: { token: { in: mintedTokens } } });
  }
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
});

test.beforeEach(() => {
  test.skip(Boolean(serverError), serverError ?? '');
});

test.describe('page sections: what a reader receives', () => {
  test('student: the page renders closed, the payload holds no locked body', async () => {
    page = await as('fake-student-1');
    const response = await page.request.get(viewPath(pageA));
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain('Public intro text');
    expect(html).toContain('Outer hint');
    for (const secret of [OUTER_SECRET, INNER_SECRET, SOLO_SECRET, 'Hidden step']) {
      expect(html).not.toContain(secret);
    }

    const data = await loaderData(page, pageA);
    expect(data.status).toBe(200);
    for (const secret of [OUTER_SECRET, INNER_SECRET, SOLO_SECRET, 'Hidden step']) {
      expect(data.text).not.toContain(secret);
    }
    // Staff-only fields are absent for a student.
    expect(data.text).not.toContain('content.json');
    expect(readerSectionsOf(data.text)).toEqual({
      staff: false,
      signedIn: true,
      canCheck: true,
      canUnlock: true,
      checked: [],
      unlocked: {},
    });
  });

  test('anonymous reader of a public page: closed, nothing to do', async () => {
    page = await as();
    const data = await loaderData(page, pageA);
    test.skip(data.status !== 200, `anonymous .data answered ${data.status}`);
    for (const secret of [OUTER_SECRET, INNER_SECRET, SOLO_SECRET]) {
      expect(data.text).not.toContain(secret);
    }
    expect(readerSectionsOf(data.text)).toEqual({
      staff: false,
      signedIn: false,
      canCheck: false,
      canUnlock: false,
      checked: [],
      unlocked: {},
    });
    const res = await sections(page, pageA, {
      pageId: pageA.pageId,
      blockId: ID.solo,
      intent: 'unlock',
    });
    expect(res.status).toBe(401);
  });

  test('assistant (teaching team): every body, staff flag, cannot unlock', async () => {
    page = await as('fake-ta');
    const data = await loaderData(page, pageA);
    expect(data.status).toBe(200);
    for (const secret of [OUTER_SECRET, INNER_SECRET, SOLO_SECRET]) {
      expect(data.text).toContain(secret);
    }
    expect(readerSectionsOf(data.text)).toMatchObject({ staff: true, canUnlock: false });
    const res = await sections(page, pageA, {
      pageId: pageA.pageId,
      blockId: ID.solo,
      intent: 'unlock',
    });
    expect(res.status).toBe(409);
  });
});

test.describe('page sections: writes and isolation', () => {
  let unlockedAt = '';

  test('student 1 unlocks the outer section: the answer holds no body; the next load does', async () => {
    page = await as('fake-student-1');

    // While outer is locked, what is inside it does not exist for this student.
    expect(
      (await sections(page, pageA, { pageId: pageA.pageId, blockId: ID.inner, intent: 'unlock' }))
        .status
    ).toBe(400);
    expect(
      (
        await sections(page, pageA, {
          pageId: pageA.pageId,
          blockId: ID.headingInOuter,
          intent: 'check',
        })
      ).status
    ).toBe(400);

    const res = await sections(page, pageA, {
      pageId: pageA.pageId,
      blockId: ID.outer,
      intent: 'unlock',
    });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(['ok', 'unlockedAt']);
    expect(res.json.ok).toBe(true);
    expect(typeof res.json.unlockedAt).toBe('string');
    expect(res.headers['cache-control']).toBe('private, no-store');
    unlockedAt = res.json.unlockedAt as string;

    // Idempotent: the first time stands.
    const again = await sections(page, pageA, {
      pageId: pageA.pageId,
      blockId: ID.outer,
      intent: 'unlock',
    });
    expect(again.json.unlockedAt).toBe(unlockedAt);

    const data = await loaderData(page, pageA);
    expect(data.text).toContain(OUTER_SECRET);
    expect(data.text).toContain('Hidden step');
    // The nested section and the other column stay locked.
    expect(data.text).not.toContain(INNER_SECRET);
    expect(data.text).not.toContain(SOLO_SECRET);

    // Check the top heading.
    const checked = await sections(page, pageA, {
      pageId: pageA.pageId,
      blockId: ID.heading,
      intent: 'check',
    });
    expect(checked).toMatchObject({ status: 200, json: { ok: true, checked: true } });

    const after = readerSectionsOf((await loaderData(page, pageA)).text);
    expect(after).toEqual({
      staff: false,
      signedIn: true,
      canCheck: true,
      canUnlock: true,
      checked: [ID.heading],
      unlocked: { [ID.outer]: unlockedAt },
    });
  });

  test('student 2 sees none of student 1’s state and gets no body', async () => {
    page = await as('fake-student-2');
    const data = await loaderData(page, pageA);
    expect(data.status).toBe(200);
    for (const secret of [OUTER_SECRET, INNER_SECRET, SOLO_SECRET, 'Hidden step']) {
      expect(data.text).not.toContain(secret);
    }
    expect(data.text).not.toContain(unlockedAt);
    expect(readerSectionsOf(data.text)).toEqual({
      staff: false,
      signedIn: true,
      canCheck: true,
      canUnlock: true,
      checked: [],
      unlocked: {},
    });
    // Student 1's unlock opened nothing for student 2.
    expect(
      (await sections(page, pageA, { pageId: pageA.pageId, blockId: ID.inner, intent: 'unlock' }))
        .status
    ).toBe(400);
  });

  test('forged block ids and wrong block types are 400', async () => {
    page = await as('fake-student-2');
    for (const [blockId, intent] of [
      [randomUUID(), 'check'],
      [randomUUID(), 'unlock'],
      [ID.outer, 'check'],
      [ID.heading, 'unlock'],
      ['not a block id', 'check'],
    ]) {
      const res = await sections(page, pageA, { pageId: pageA.pageId, blockId, intent });
      expect(res.status, `${intent} ${blockId}`).toBe(400);
    }
  });

  test('a page from another classroom is 404, either way round', async () => {
    page = await as('fake-student-1');
    const crossB = await sections(page, pageB, {
      pageId: pageB.pageId,
      blockId: ID.bHeading,
      intent: 'check',
    });
    expect(crossB.status).toBe(404);
    const unknown = await sections(page, pageA, {
      pageId: randomUUID(),
      blockId: ID.heading,
      intent: 'check',
    });
    expect(unknown.status).toBe(404);
    expect(crossB.json).toEqual(unknown.json);

    page = await as('fake-other-student');
    const crossA = await sections(page, pageA, {
      pageId: pageA.pageId,
      blockId: ID.solo,
      intent: 'unlock',
    });
    expect(crossA.status).toBe(404);
    // Their own classroom's page works.
    const own = await sections(page, pageB, {
      pageId: pageB.pageId,
      blockId: ID.bHeading,
      intent: 'check',
    });
    expect(own.status).toBe(200);
  });

  test('a cross-site POST is refused', async () => {
    page = await as('fake-student-2');
    const res = await sections(
      page,
      pageA,
      { pageId: pageA.pageId, blockId: ID.heading, intent: 'check' },
      { origin: 'https://evil.example' }
    );
    expect(res.status).toBe(403);
  });

  test('an impersonated session writes nothing', async () => {
    page = await as('fake-student-3', 'timofei7');
    for (const [blockId, intent] of [
      [ID.heading, 'check'],
      [ID.solo, 'unlock'],
    ]) {
      const res = await sections(page, pageA, { pageId: pageA.pageId, blockId, intent });
      expect(res.status).toBe(403);
    }
    const prisma = await getTestPrisma();
    const student3 = await userIdFor('fake-student-3');
    expect(
      await prisma.pageSectionUnlock.count({ where: { page_id: pageA.pageId, user_id: student3 } })
    ).toBe(0);
    expect(
      await prisma.pageSectionCheck.count({ where: { page_id: pageA.pageId, user_id: student3 } })
    ).toBe(0);
    // The viewer still renders as that student (closed), with nothing to do.
    const data = await loaderData(page, pageA);
    expect(data.text).not.toContain(SOLO_SECRET);
    expect(readerSectionsOf(data.text)).toMatchObject({ canCheck: false, canUnlock: false });
  });
});

test.describe('page sections: the staff unlock list', () => {
  test('a student, the assistant and another classroom’s owner get 404', async () => {
    for (const login of ['fake-student-1', 'fake-ta', 'fake-other-owner']) {
      page = await as(login);
      const res = await unlockList(page, pageA, ID.outer);
      expect(res.status, login).toBe(404);
      expect(JSON.stringify(res.json)).not.toContain('fake-student-1');
    }
    // And class A's teacher cannot read class B's list.
    page = await as('fake-teacher');
    expect((await unlockList(page, pageB, ID.bLock)).status).toBe(404);
  });

  test('the teacher sees who unlocked, current students only, and the read is audited', async () => {
    page = await as('fake-teacher');
    const res = await unlockList(page, pageA, ID.outer);
    expect(res.status).toBe(200);
    const unlocks = res.json.unlocks as Array<Record<string, unknown>>;
    expect(unlocks.map(u => u.login)).toEqual(['fake-student-1']);
    expect(typeof unlocks[0]!.unlockedAt).toBe('string');
    expect(typeof res.json.students).toBe('number');

    // Nobody unlocked solo.
    expect(((await unlockList(page, pageA, ID.solo)).json.unlocks as unknown[]).length).toBe(0);

    const prisma = await getTestPrisma();
    const views = await prisma.auditLog.findMany({
      where: {
        user_id: await userIdFor('fake-teacher'),
        resource_type: 'PAGES',
        resource_id: pageA.pageId,
        action: 'VIEW',
      },
      select: { data: true, role: true },
    });
    // One row per section read: block_id is part of the audit service's
    // 5-second dedup key, so the second read (solo, inside the window) is its
    // own row rather than coalesced into the first.
    const view = (blockId: string) => ({
      role: 'TEACHER',
      data: { tool: 'page_section_unlocks', via: 'web', page_id: pageA.pageId, block_id: blockId },
    });
    expect(views).toContainEqual(view(ID.outer));
    expect(views).toContainEqual(view(ID.solo));
  });
});

test.describe('page sections: audit rows', () => {
  test('student 1’s unlock (once) and check are logged; nothing for refused writes', async () => {
    const prisma = await getTestPrisma();
    const rows = await prisma.auditLog.findMany({
      where: {
        resource_type: 'PAGES',
        resource_id: pageA.pageId,
        action: { in: ['CREATE', 'DELETE'] },
      },
      select: { user_id: true, role: true, action: true, data: true, classroom_id: true },
      orderBy: { timestamp: 'asc' },
    });
    const student1 = await userIdFor('fake-student-1');
    expect(rows.filter(row => row.user_id === student1)).toEqual([
      {
        user_id: student1,
        role: 'STUDENT',
        action: 'CREATE',
        classroom_id: pageA.classroomId,
        data: {
          tool: 'page_section_unlock',
          via: 'web',
          page_id: pageA.pageId,
          block_id: ID.outer,
        },
      },
      {
        user_id: student1,
        role: 'STUDENT',
        action: 'CREATE',
        classroom_id: pageA.classroomId,
        data: {
          tool: 'page_section_check',
          via: 'web',
          page_id: pageA.pageId,
          block_id: ID.heading,
          checked: true,
        },
      },
    ]);
    // The impersonated student and the 409'd assistant wrote nothing, so logged nothing.
    for (const login of ['fake-student-3', 'fake-ta']) {
      const id = await userIdFor(login);
      expect(
        rows.filter(row => row.user_id === id),
        login
      ).toEqual([]);
    }
  });
});

// Last on purpose: in serial mode a failure stops the tests after it, and
// this one depends on route.tsx re-exporting `headers` from route.server.ts.
test.describe('page sections: caching', () => {
  test('the page route answers private, no-store, Vary: Cookie (document and .data)', async () => {
    page = await as('fake-student-1');
    const doc = await page.request.get(viewPath(pageA));
    const data = await page.request.get(dataPath(pageA));
    for (const res of [doc, data]) {
      expect(res.headers()['cache-control']).toBe('private, no-store');
      expect(res.headers()['vary'] ?? '').toMatch(/cookie/i);
    }
  });
});
