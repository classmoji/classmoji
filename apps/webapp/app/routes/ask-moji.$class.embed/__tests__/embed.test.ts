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

const access = (roles: string[]) => ({
  userId: 'u1',
  roles,
  classroom: { id: 'class-1', slug: 'cs1', name: 'CS 1', status: 'ACTIVE' },
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
});
