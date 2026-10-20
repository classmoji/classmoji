import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MOJI_AVAILABILITY_COPY, ASK_MOJI_COPY } from '@classmoji/utils/ask-moji';

const assertAccessMock = vi.fn();
const availableMock = vi.fn();
vi.mock('@classmoji/auth/server', () => ({
  assertAskMojiAccess: (...a: unknown[]) => assertAccessMock(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { askMojiSession: { askMojiAvailable: (i: unknown) => availableMock(i) } },
}));

const { embedHeaders, loadEmbed } = await import('../embed.server');

const ENV = {
  NODE_ENV: 'production',
  WEBAPP_URL: 'https://classmoji.io',
  PAGES_URL: 'https://pages.classmoji.io',
  SLIDES_URL: 'https://slides.classmoji.io',
};

const request = (parentOrigin?: string) =>
  new Request(
    `http://classmoji.io/ask-moji/cs1/embed${parentOrigin ? `?parentOrigin=${encodeURIComponent(parentOrigin)}` : ''}`
  );

const access = (
  roles: string[],
  {
    userId = 'u1',
    classroom = { id: 'class-1', slug: 'cs1', name: 'CS 1', status: 'ACTIVE' },
    impersonatedBy,
  }: {
    userId?: string;
    classroom?: { id: string; slug: string; name: string; status: string };
    impersonatedBy?: string;
  } = {}
) => ({
  userId,
  actorUserId: impersonatedBy ?? userId,
  impersonation: impersonatedBy
    ? { by: impersonatedBy, sessionId: 'imp-1', expiresAt: null }
    : null,
  roles,
  classroom,
});

beforeEach(() => {
  vi.clearAllMocks();
  availableMock.mockResolvedValue({ available: true });
});

describe('framing headers', () => {
  it('frame-ancestors names only the pages and slides origins, and no X-Frame-Options', () => {
    const headers = embedHeaders(ENV);
    expect(headers['Content-Security-Policy']).toBe(
      'frame-ancestors https://pages.classmoji.io https://slides.classmoji.io'
    );
    expect(headers).not.toHaveProperty('X-Frame-Options');
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('production without either URL frames for nobody (no localhost fallback)', () => {
    expect(embedHeaders({ NODE_ENV: 'production' })['Content-Security-Policy']).toBe(
      "frame-ancestors 'none'"
    );
  });

  it('no other route, and not the root, lets anyone frame it', () => {
    const appDir = fileURLToPath(new URL('../../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
        } else if (/\.(tsx?|jsx?)$/.test(name) && !full.includes('ask-moji.$class.embed')) {
          const source = readFileSync(full, 'utf8');
          // A deny policy (`frame-ancestors 'none'`, the OAuth consent page) is fine.
          if (
            /frame-ancestors (?!'none')/.test(source) &&
            !full.endsWith('features/ask-moji/protocol.ts')
          ) {
            offenders.push(full);
          }
        }
      }
    };
    walk(join(appDir, 'routes'));
    walk(join(appDir, 'components'));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(appDir, 'root.tsx'), 'utf8')).not.toMatch(
      /export (const|function) headers/
    );
  });
});

describe('loader', () => {
  it('a member of an available classroom gets the panel, with the checked parent origin', async () => {
    assertAccessMock.mockResolvedValue(access(['STUDENT']));
    const data = await loadEmbed(request('https://pages.classmoji.io'), 'cs1', ENV);
    expect(data).toEqual({
      state: 'ready',
      parentOrigin: 'https://pages.classmoji.io',
      classroomSlug: 'cs1',
      courseName: 'CS 1',
      pagesUrl: 'https://pages.classmoji.io',
      slidesUrl: 'https://slides.classmoji.io',
      impersonated: false,
    });
    expect(assertAccessMock).toHaveBeenCalledWith(expect.any(Request), 'cs1', {
      resourceType: 'ASK_MOJI',
      action: 'embed',
    });
    expect(availableMock).toHaveBeenCalledWith({ classroomId: 'class-1' });
  });

  it('an unlisted parent origin is dropped (the frame then posts nothing)', async () => {
    assertAccessMock.mockResolvedValue(access(['STUDENT']));
    for (const claim of [
      'https://evil.example',
      'https://classmoji.io',
      'https://pages.classmoji.io/',
    ]) {
      expect((await loadEmbed(request(claim), 'cs1', ENV)).parentOrigin).toBeNull();
    }
  });

  it('signed out: a sign-in prompt, never a redirect or a throw', async () => {
    assertAccessMock.mockRejectedValue(new Response('Unauthorized', { status: 401 }));
    expect(await loadEmbed(request('https://slides.classmoji.io'), 'cs1', ENV)).toEqual({
      state: 'signed-out',
      parentOrigin: 'https://slides.classmoji.io',
      signInUrl: 'https://classmoji.io/',
    });
  });

  it('not a member: the members’ line', async () => {
    assertAccessMock.mockRejectedValue(new Response('Not a member', { status: 403 }));
    expect(await loadEmbed(request(), 'cs1', ENV)).toEqual({
      state: 'unavailable',
      parentOrigin: null,
      line: ASK_MOJI_COPY.UNAVAILABLE,
      staffLine: null,
    });
  });

  it('unavailable: why for OWNER/TEACHER only', async () => {
    availableMock.mockResolvedValue({ available: false, reason: 'NOT_ENABLED' });
    assertAccessMock.mockResolvedValue(access(['STUDENT']));
    expect(await loadEmbed(request(), 'cs1', ENV)).toMatchObject({ staffLine: null });
    assertAccessMock.mockResolvedValue(access(['OWNER']));
    expect(await loadEmbed(request(), 'cs1', ENV)).toMatchObject({
      state: 'unavailable',
      line: ASK_MOJI_COPY.UNAVAILABLE,
      staffLine: ASK_MOJI_AVAILABILITY_COPY.NOT_ENABLED,
    });
  });

  it('an unexpected failure is the members’ line, not a throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertAccessMock.mockRejectedValue(new Error('db down'));
    expect((await loadEmbed(request(), 'cs1', ENV)).state).toBe('unavailable');
  });

  it('an impersonated session is marked (from the access check), so the frame can say so', async () => {
    assertAccessMock.mockResolvedValue(access(['STUDENT'], { impersonatedBy: 'admin-9' }));
    const data = await loadEmbed(request('https://pages.classmoji.io'), 'cs1', ENV);
    expect(data).toMatchObject({ state: 'ready', impersonated: true });
    // Nothing about who is behind it reaches the frame.
    expect(JSON.stringify(data)).not.toContain('admin-9');
  });
});

describe('scoping: user B, classroom Y', () => {
  const X = { id: 'class-x', slug: 'cs-x', name: 'CS X', status: 'ACTIVE' };
  const Y = { id: 'class-y', slug: 'cs-y', name: 'CS Y', status: 'ACTIVE' };

  /** The access check as the server answers it: user A is in X and Y, user B only in X. */
  const signedInAs = (userId: 'user-a' | 'user-b') =>
    assertAccessMock.mockImplementation(async (_request: Request, slug: string) => {
      const classroom = [X, Y].find(c => c.slug === slug);
      if (!classroom) throw new Response('Not Found', { status: 404 });
      if (userId === 'user-b' && classroom === Y) {
        throw new Response('Not a member of this classroom', { status: 403 });
      }
      return access(['STUDENT'], { userId, classroom });
    });

  it('user B, not a member of classroom Y, gets the members’ line and nothing of Y', async () => {
    signedInAs('user-b');
    const data = await loadEmbed(request(), 'cs-y', ENV);
    expect(data).toEqual({
      state: 'unavailable',
      parentOrigin: null,
      line: ASK_MOJI_COPY.UNAVAILABLE,
      staffLine: null,
    });
    expect(JSON.stringify(data)).not.toContain('CS Y');
    expect(availableMock).not.toHaveBeenCalled();
  });

  it('the panel names the classroom the access check resolved, never one from the query', async () => {
    signedInAs('user-a');
    const tampered = new Request(
      'http://classmoji.io/ask-moji/cs-y/embed?classroomSlug=cs-x&classroomId=class-x&userId=user-b'
    );
    const data = await loadEmbed(tampered, 'cs-y', ENV);
    expect(data).toMatchObject({ state: 'ready', classroomSlug: 'cs-y', courseName: 'CS Y' });
    expect(availableMock).toHaveBeenCalledWith({ classroomId: 'class-y' });
    expect(availableMock).not.toHaveBeenCalledWith({ classroomId: 'class-x' });
  });

  it('classroom Y’s availability never decides classroom X’s embed', async () => {
    signedInAs('user-a');
    availableMock.mockImplementation(async ({ classroomId }: { classroomId: string }) =>
      classroomId === 'class-y' ? { available: false, reason: 'NOT_ENABLED' } : { available: true }
    );
    expect((await loadEmbed(request(), 'cs-x', ENV)).state).toBe('ready');
    expect((await loadEmbed(request(), 'cs-y', ENV)).state).toBe('unavailable');
  });
});
