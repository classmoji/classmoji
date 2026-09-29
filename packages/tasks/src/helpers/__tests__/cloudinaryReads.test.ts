/**
 * The live read deps against fake Prisma / fetch: the dry run's reads really
 * are reads (every write method spied, every HTTP method recorded), the
 * restated Pro and quota rules match the services', and the Cloudinary and
 * GitHub readers follow their APIs.
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  PRO_QUOTA_BYTES as SERVICES_PRO_QUOTA,
  RESERVATION_WINDOW_MS as SERVICES_WINDOW,
} from '../../../../services/src/media/mediaQuota.ts';
import { planMigration } from '../cloudinaryPlan.ts';
import {
  PRO_QUOTA_BYTES,
  RESERVATION_WINDOW_MS,
  createGitHubReader,
  createLiveReadDeps,
  isProFromOwners,
  listCloudinaryVideos,
  lookupCloudinaryVideo,
  type ReadPrisma,
} from '../cloudinaryReads.ts';

const CLOUD = 'classmoji-test';
const CLASSROOM = '11111111-2222-4333-8444-555555555555';
const PUBLIC_ID = 'classmoji/slides/s1/aaaa';
const VIDEO_URL = `https://res.cloudinary.com/${CLOUD}/video/upload/f_auto,q_auto/v1/${PUBLIC_ID}?_a=BAMAOGfm0`;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('restated services rules', () => {
  it('pins the quota and reservation window to the services constants', () => {
    expect(PRO_QUOTA_BYTES).toBe(SERVICES_PRO_QUOTA);
    expect(RESERVATION_WINDOW_MS).toBe(SERVICES_WINDOW);
  });

  it('Pro: any owner with an active PRO wins; else the oldest owner decides', () => {
    const now = Date.parse('2026-09-27T00:00:00Z');
    const lapsed = { tier: 'PRO', ends_at: '2026-01-01T00:00:00Z' };
    const open = { tier: 'PRO', ends_at: null };
    const free = { tier: 'FREE', ends_at: null };
    expect(isProFromOwners([free, open], now)).toBe(true);
    expect(isProFromOwners([lapsed, free], now)).toBe(false);
    expect(isProFromOwners([null], now)).toBe(false);
    expect(isProFromOwners([], now)).toBe(false);
    expect(isProFromOwners([{ tier: 'PRO', ends_at: '2027-01-01T00:00:00Z' }], now)).toBe(true);
    expect(isProFromOwners([{ tier: 'PRO', ends_at: 'garbage' }], now)).toBe(false);
  });
});

describe('listCloudinaryVideos', () => {
  it('lists video/upload under the prefix, 500 at a time, following next_cursor', async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init: init ?? {} });
      const resource = (id: string) => ({
        public_id: id,
        format: 'MP4',
        bytes: 5,
        version: 7,
        secure_url: `https://res.cloudinary.com/${CLOUD}/video/upload/v7/${id}.mp4`,
      });
      return url.searchParams.get('next_cursor')
        ? json({ resources: [resource('classmoji/slides/s/b')] })
        : json({ resources: [resource('classmoji/slides/s/a')], next_cursor: 'c1' });
    }) as unknown as typeof fetch;

    const assets = await listCloudinaryVideos(
      { cloudName: CLOUD, apiKey: 'k', apiSecret: 's' },
      fetchImpl
    );
    expect(assets.map(a => [a.publicId, a.format, a.bytes])).toEqual([
      ['classmoji/slides/s/a', 'mp4', 5],
      ['classmoji/slides/s/b', 'mp4', 5],
    ]);
    expect(calls).toHaveLength(2);
    const first = calls[0]!;
    expect(first.url.pathname).toBe(`/v1_1/${CLOUD}/resources/video/upload`);
    expect(first.url.searchParams.get('prefix')).toBe('classmoji/slides/');
    expect(first.url.searchParams.get('max_results')).toBe('500');
    expect(calls[1]!.url.searchParams.get('next_cursor')).toBe('c1');
    expect(calls.every(c => c.init.method === 'GET')).toBe(true);
    expect((first.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('k:s').toString('base64')}`
    );
  });

  it('refuses an incomplete resource rather than dropping it', async () => {
    const fetchImpl = vi.fn(async () => json({ resources: [{ public_id: 'x' }] }));
    await expect(
      listCloudinaryVideos({ cloudName: CLOUD, apiKey: 'k', apiSecret: 's' }, fetchImpl as never)
    ).rejects.toThrow(/incomplete resource/);
  });
});

describe('lookupCloudinaryVideo', () => {
  const creds = { cloudName: CLOUD, apiKey: 'k', apiSecret: 's' };
  const resource = {
    public_id: 'cs52-projects/team a',
    format: 'mov',
    bytes: 9,
    version: 3,
    secure_url: `https://res.cloudinary.com/${CLOUD}/video/upload/v3/cs52-projects/team%20a.mov`,
  };

  it('GETs one resource by its path-encoded public_id', async () => {
    const seen: { url: string; method?: string }[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method });
      return json(resource);
    }) as unknown as typeof fetch;
    const asset = await lookupCloudinaryVideo(creds, 'cs52-projects/team a', fetchImpl);
    expect(seen).toEqual([
      {
        url: `https://api.cloudinary.com/v1_1/${CLOUD}/resources/video/upload/cs52-projects/team%20a`,
        method: 'GET',
      },
    ]);
    expect(asset).toMatchObject({ publicId: 'cs52-projects/team a', bytes: 9, format: 'mov' });
  });

  it('answers null on 404 and throws on anything else or a different id', async () => {
    const answer = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
    expect(await lookupCloudinaryVideo(creds, 'x/y', answer(json({}, 404)))).toBeNull();
    await expect(lookupCloudinaryVideo(creds, 'x/y', answer(json({}, 500)))).rejects.toThrow(
      /HTTP 500/
    );
    await expect(lookupCloudinaryVideo(creds, 'x/other', answer(json(resource)))).rejects.toThrow(
      /answered cs52-projects\/team a for x\/other/
    );
  });
});

describe('createGitHubReader', () => {
  it('mints a contents:read token once, GETs, and falls back to the blob for large files', async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url.endsWith('/access_tokens')) {
        return json({ token: 'tok', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (url.includes('/git/blobs/')) {
        return json({ content: Buffer.from('big file').toString('base64') });
      }
      if (url.includes('index.html'))
        return json({ type: 'file', sha: 'h1', encoding: 'none', content: '' });
      if (url.includes('deck.json')) {
        return json({
          type: 'file',
          sha: 'd1',
          encoding: 'base64',
          content: Buffer.from('{}').toString('base64'),
        });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const reader = createGitHubReader({ appId: '1', privateKeyPem: PEM }, fetchImpl);
    expect(await reader.readFile('42', 'org', 'repo', 'slides/a/deck.json')).toEqual({
      sha: 'd1',
      text: '{}',
    });
    expect(await reader.readFile('42', 'org', 'repo', 'slides/a/index.html')).toEqual({
      sha: 'h1',
      text: 'big file',
    });
    expect(await reader.readFile('42', 'org', 'repo', 'slides/a/missing')).toBeNull();

    const mints = calls.filter(c => c.url.endsWith('/access_tokens'));
    expect(mints).toHaveLength(1);
    expect(JSON.parse(mints[0]!.body!)).toEqual({ permissions: { contents: 'read' } });
    expect(
      calls.filter(c => !c.url.endsWith('/access_tokens')).every(c => c.method === 'GET')
    ).toBe(true);
  });
});

describe('dry run makes no writes', () => {
  it('reads through the live deps without touching a write method or a non-GET endpoint', async () => {
    const writes = {
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };
    const model = (rows: unknown[]) => ({
      findMany: vi.fn(async (_args?: unknown) => rows),
      ...writes,
    });
    const prisma = {
      slide: model([
        {
          id: 'deck-1',
          classroom_id: CLASSROOM,
          title: 'Week 1',
          content_path: 'slides/week-1',
          created_by: 'user-1',
        },
      ]),
      classroom: model([
        {
          id: CLASSROOM,
          slug: 'cs1',
          name: 'CS 1',
          is_archived: true,
          status: 'ACTIVE',
          content_repo: 'content-cs1',
          content_delivery_enabled: true,
          git_organization: { provider: 'GITHUB', login: 'org', github_installation_id: '42' },
          memberships: [{ user: { subscriptions: [{ tier: 'PRO', ends_at: null }] } }],
        },
      ]),
      mediaObject: model([
        {
          classroom_id: CLASSROOM,
          size_bytes: 10n,
          rendition_bytes: null,
          original_deleted_at: null,
        },
        {
          classroom_id: CLASSROOM,
          size_bytes: 100n,
          rendition_bytes: 4n,
          original_deleted_at: new Date(),
        },
      ]),
      $executeRaw: vi.fn(),
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
    };

    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? 'GET'} ${new URL(url).hostname}${new URL(url).pathname}`);
      if (url.includes('/resources/video/upload/cs52-projects/')) {
        return json({
          public_id: 'cs52-projects/team-a',
          format: 'mp4',
          bytes: 50,
          version: 2,
          secure_url: 'https://x/team-a.mp4',
        });
      }
      if (url.includes('api.cloudinary.com')) {
        return json({
          resources: [
            {
              public_id: PUBLIC_ID,
              format: 'mp4',
              bytes: 1000,
              version: 1,
              secure_url: 'https://x/y.mp4',
            },
          ],
        });
      }
      if (url.endsWith('/access_tokens')) return json({ token: 't' });
      if (url.includes('ref=preview')) return json({}, 404);
      if (url.includes('deck.json')) {
        const text = JSON.stringify({
          attrs: { 'data-background-video': VIDEO_URL },
          src: `https://res.cloudinary.com/${CLOUD}/video/upload/q_auto/cs52-projects/team-a.mp4`,
        });
        return json({
          type: 'file',
          sha: 's1',
          encoding: 'base64',
          content: Buffer.from(text).toString('base64'),
        });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const deps = createLiveReadDeps({
      prisma: prisma as unknown as ReadPrisma,
      cloudinary: { cloudName: CLOUD, apiKey: 'k', apiSecret: 's' },
      github: { appId: '1', privateKeyPem: PEM },
      fetchImpl,
    });
    const plan = await planMigration(deps);

    for (const spy of [
      ...Object.values(writes),
      prisma.$executeRaw,
      prisma.$executeRawUnsafe,
      prisma.$transaction,
    ]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(methods.filter(m => !m.startsWith('GET '))).toEqual([
      'POST api.github.com/app/installations/42/access_tokens',
    ]);

    expect(plan.classrooms).toEqual([
      expect.objectContaining({
        classroomId: CLASSROOM,
        isPro: true,
        isArchived: true,
        usedBytes: 14,
        bytesToAdd: 1050,
        canServeMedia: true,
      }),
    ]);
    expect(plan.totals.backgroundVideoReferences).toBe(1);
    // The unlisted URL was looked up by public_id — a GET, like everything else.
    expect(methods).toContain(
      `GET api.cloudinary.com/v1_1/${CLOUD}/resources/video/upload/cs52-projects/team-a`
    );
    expect(plan.assets.find(a => a.publicId === 'cs52-projects/team-a')?.source).toBe(
      'other-folder'
    );
    // The select never names the GitLab token column.
    const classroomArgs = JSON.stringify(prisma.classroom.findMany.mock.calls[0]);
    expect(classroomArgs).not.toContain('access_token');
    // Every classroom with a deck, whatever its status: no status filter.
    expect(prisma.slide.findMany.mock.calls[0]![0]).toMatchObject({ where: { kind: 'DECK' } });
  });
});
