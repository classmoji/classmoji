import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOX_CONTENT_SECURITY_POLICY,
  PREVIEW_FRAME_HTML,
  STORAGE_SHIM,
  shimOffset,
} from '../src/box.ts';
import { CONTENT_SECURITY_POLICY } from '../src/cache.ts';
import worker, { clearRotationLog } from '../src/index.ts';
import { clearOriginCache } from '../src/token.ts';
import { encodeFilesGrant, type FilesFolder } from '../src/verify.ts';
import {
  CLASSROOM,
  MASTER,
  ORIGIN,
  TREE_SHA,
  fakeBucket,
  fakeContext,
  fakeEnv,
  futureExp,
  signedFilesUrl,
  signedThemeUrl,
} from './helpers.ts';

const realFetch = globalThis.fetch;

beforeEach(() => {
  clearOriginCache();
  clearRotationLog();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const sha = (char: string) => char.repeat(40);

const DECK_TREE = sha('d');
const PAGE_TREE = sha('e');
const CASED_TREE = sha('f');

const GAME: FilesFolder = { path: 'games/snake', treeSha: TREE_SHA };
const DECK: FilesFolder = { path: 'slides/intro', treeSha: DECK_TREE };
const PAGE: FilesFolder = { path: 'pages/week1', treeSha: PAGE_TREE };
const CASED: FilesFolder = { path: 'Slides/Intro', treeSha: CASED_TREE };

const FILES: Record<string, { sha: string; body: string }> = {
  'index.html': { sha: sha('1'), body: '<!DOCTYPE html>\n<html><body>snake</body></html>' },
  'bare.html': { sha: sha('2'), body: '<canvas></canvas><script>go()</script>' },
  'commented.html': { sha: sha('3'), body: '<!-- built --> <!doctype html><p>x</p>' },
  'bom.html': { sha: sha('4'), body: '﻿<p>bom</p>' },
  'app.js': { sha: sha('5'), body: 'go()' },
  'style.css': { sha: sha('6'), body: 'body{}' },
  'sprite.png': { sha: sha('7'), body: 'png-bytes' },
  'icon.svg': { sha: sha('8'), body: '<svg onload="x()"></svg>' },
  'levels/one.json': { sha: sha('9'), body: '{"level":1}' },
  'page.xhtml': {
    sha: sha('b'),
    body: '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>',
  },
};

const listing = (paths: Record<string, { sha: string }>) =>
  JSON.stringify(
    Object.entries(paths).map(([path, file]) => ({ path, sha: file.sha, type: 'blob' }))
  );

/** R2 already holding every tree and blob the tests ask for. */
function warmBucket() {
  const objects: Record<string, { body: string; contentType?: string }> = {
    [`trees/${TREE_SHA}.json`]: { body: listing(FILES) },
    [`trees/${DECK_TREE}.json`]: {
      body: listing({
        'deck.json': { sha: sha('a') },
        'index.html': { sha: sha('a') },
        'blocks/b1.html': { sha: sha('1') },
      }),
    },
    [`trees/${PAGE_TREE}.json`]: {
      body: listing({ 'content.json': { sha: sha('a') }, 'index.html': { sha: sha('a') } }),
    },
    [`trees/${CASED_TREE}.json`]: {
      body: listing({ 'Deck.JSON': { sha: sha('a') }, 'Index.HTML': { sha: sha('a') } }),
    },
    [`blobs/${sha('a')}`]: { body: 'document' },
  };
  for (const file of Object.values(FILES)) objects[`blobs/${file.sha}`] = { body: file.body };
  return fakeBucket(objects);
}

async function fetchFile(
  repoPath: string,
  options: {
    folders?: FilesFolder[];
    init?: RequestInit;
    bucket?: ReturnType<typeof fakeBucket>;
  } = {}
) {
  const bucket = options.bucket ?? warmBucket();
  const url = await signedFilesUrl({ folders: options.folders ?? [GAME], repoPath });
  const response = await worker.fetch(
    new Request(url, options.init),
    fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
    fakeContext()
  );
  return { response, bucket, url };
}

describe('files delivery', () => {
  it('serves a file inside a granted folder, immutable, under the strict policy', async () => {
    const { response, bucket } = await fetchFile('games/snake/app.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('go()');
    expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+, immutable$/);
    expect(response.headers.get('Referrer-Policy')).toBeNull();
    expect(bucket.gets).toEqual([`trees/${TREE_SHA}.json`, `blobs/${FILES['app.js'].sha}`]);
  });

  it('serves files in nested folders by exact path', async () => {
    const { response } = await fetchFile('games/snake/levels/one.json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ level: 1 });
  });

  it.each(['style.css', 'app.js', 'sprite.png', 'icon.svg', 'levels/one.json'])(
    'keeps the strict policy byte for byte on %s',
    async file => {
      const { response } = await fetchFile(`games/snake/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
      expect(response.headers.get('Referrer-Policy')).toBeNull();
    }
  );

  it('boxes HTML: sandbox with scripts and no same-origin, no referrer, shim after the doctype', async () => {
    const { response } = await fetchFile('games/snake/index.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).toBe(BOX_CONTENT_SECURITY_POLICY);
    expect(csp).toBe(
      'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox ' +
        'allow-modals allow-pointer-lock allow-downloads'
    );
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).not.toContain('allow-top-navigation');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    // Still a content response in every other respect.
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Cache-Control')).toMatch(/immutable$/);

    const body = await response.text();
    expect(body).toBe(`<!DOCTYPE html>${STORAGE_SHIM}\n<html><body>snake</body></html>`);
    expect(body).toContain('data-cm-storage-shim');
    // The stored length describes the file, not the reply.
    expect(response.headers.get('Content-Length')).toBe(
      String(new TextEncoder().encode(body).byteLength)
    );
    expect(response.headers.get('ETag')).toBeNull();
    expect(response.headers.get('Accept-Ranges')).toBeNull();
  });

  it('boxes XHTML without the shim, bytes and length as stored', async () => {
    const { response } = await fetchFile('games/snake/page.xhtml');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xhtml+xml; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(BOX_CONTENT_SECURITY_POLICY);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const body = await response.text();
    expect(body).toBe(FILES['page.xhtml'].body);
    expect(body).not.toContain('data-cm-storage-shim');
    expect(response.headers.get('Content-Length')).toBe(
      String(new TextEncoder().encode(FILES['page.xhtml'].body).byteLength)
    );
  });

  it('answers HEAD on XHTML with the box headers and its stored length', async () => {
    const { response } = await fetchFile('games/snake/page.xhtml', { init: { method: 'HEAD' } });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(BOX_CONTENT_SECURITY_POLICY);
    expect(response.headers.get('Content-Length')).toBe(
      String(new TextEncoder().encode(FILES['page.xhtml'].body).byteLength)
    );
  });

  it('puts the shim first when the page has no doctype', async () => {
    const { response } = await fetchFile('games/snake/bare.html');
    expect(await response.text()).toBe(`${STORAGE_SHIM}${FILES['bare.html'].body}`);
  });

  it('skips leading comments to find the doctype', async () => {
    const { response } = await fetchFile('games/snake/commented.html');
    expect(await response.text()).toBe(`<!-- built --> <!doctype html>${STORAGE_SHIM}<p>x</p>`);
  });

  it('keeps a byte order mark first', async () => {
    const { response } = await fetchFile('games/snake/bom.html');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.subarray(3))).toBe(`${STORAGE_SHIM}<p>bom</p>`);
  });

  it('answers HEAD on HTML with the box headers and no body', async () => {
    const { response } = await fetchFile('games/snake/index.html', { init: { method: 'HEAD' } });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('Content-Security-Policy')).toBe(BOX_CONTENT_SECURITY_POLICY);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Length')).toBeNull();
  });

  it('answers HEAD on other files from R2 metadata', async () => {
    const { response, bucket } = await fetchFile('games/snake/app.js', {
      init: { method: 'HEAD' },
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('Content-Length')).toBe('4');
    expect(bucket.heads).toEqual([`blobs/${FILES['app.js'].sha}`]);
  });

  it('serves HTML whole even when a range is asked for', async () => {
    const { response } = await fetchFile('games/snake/index.html', {
      init: { headers: { Range: 'bytes=0-3' } },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(STORAGE_SHIM);
  });

  it('still serves ranges on other files', async () => {
    const { response } = await fetchFile('games/snake/sprite.png', {
      init: { headers: { Range: 'bytes=0-2' } },
    });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('png');
  });

  it('passes a query string through and does not let it change anything', async () => {
    const bucket = warmBucket();
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/index.html' });
    const response = await worker.fetch(
      new Request(`${url}?deck=x&f=y&sig=secretvalue&p=edit`),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      fakeContext()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toMatch(/immutable$/);
    expect(await response.text()).toContain('snake');
  });

  it('404s a file outside every granted folder', async () => {
    for (const repoPath of [
      'games/other/index.html',
      'games/snake-2/index.html',
      'games/index.html',
      'index.html',
    ]) {
      const { response, bucket } = await fetchFile(repoPath);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
      expect(bucket.gets).toEqual([]);
    }
  });

  it('404s the granted folder itself and a path missing from its tree', async () => {
    expect((await fetchFile('games/snake')).response.status).toBe(404);
    expect((await fetchFile('games/snake/')).response.status).toBe(404);
    expect((await fetchFile('games/snake/missing.js')).response.status).toBe(404);
  });

  it('404s deck and page documents even inside a granted folder', async () => {
    for (const [folder, repoPath] of [
      [DECK, 'slides/intro/deck.json'],
      [DECK, 'slides/intro/index.html'],
      [PAGE, 'pages/week1/content.json'],
      [PAGE, 'pages/week1/index.html'],
      [CASED, 'Slides/Intro/Deck.JSON'],
      [CASED, 'Slides/Intro/Index.HTML'],
    ] as const) {
      const { response, bucket } = await fetchFile(repoPath, { folders: [folder] });
      expect(response.status).toBe(404);
      expect(bucket.gets).toEqual([]);
    }
    // Other files in the same folder are served.
    const { response } = await fetchFile('slides/intro/blocks/b1.html', { folders: [DECK] });
    expect(response.status).toBe(200);
  });

  it('refuses dot segments and encoded separators in the path', async () => {
    const bucket = warmBucket();
    const base = (await signedFilesUrl({ folders: [GAME], repoPath: '' })).replace(/\/$/, '');
    const env = fakeEnv({ CACHE: bucket as unknown as R2Bucket });
    for (const tail of [
      'games/snake/..%2f..%2fslides%2fintro%2fdeck.json',
      'games/snake/%252e%252e/index.html',
      'games/snake/a%5Cb.html',
      'games/snake//app.js',
      'games/snake/%00app.js',
    ]) {
      const response = await worker.fetch(new Request(`${base}/${tail}`), env, fakeContext());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'malformed' });
    }
    // `..` and `%2e%2e` are both dot segments to the URL parser, resolved
    // before the Worker sees the path. That lands it outside the folder: a 404
    // rather than the file.
    for (const tail of [
      'games/snake/../../slides/intro/deck.json',
      'games/snake/%2e%2e/%2e%2e/slides/intro/deck.json',
      'games/snake/%2E%2E/other/index.html',
      'games/snake/../other/index.html',
    ]) {
      const response = await worker.fetch(new Request(`${base}/${tail}`), env, fakeContext());
      expect(response.status).toBe(404);
    }
    expect(bucket.gets).toEqual([]);
  });

  it('403s a tampered grant, signature or expiry, and an expired URL', async () => {
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/app.js' });
    const grant = encodeFilesGrant([GAME]);
    const wider = encodeFilesGrant([{ path: 'games', treeSha: TREE_SHA }]);
    const env = fakeEnv({ CACHE: warmBucket() as unknown as R2Bucket });

    const swapped = url.replace(`/files/${grant}/`, `/files/${wider}/`);
    const [, policy] = /\/files\/[^/]+\/([^/]+)\//.exec(url) ?? [];
    const [tier, version, exp, sig] = policy.split('.');
    const badSig = url.replace(policy, `${tier}.${version}.${exp}.${sig.slice(0, -2)}AA`);
    const longer = url.replace(policy, `${tier}.${version}.${Number(exp) + 86_400}.${sig}`);

    for (const tampered of [swapped, badSig, longer]) {
      const response = await worker.fetch(new Request(tampered), env, fakeContext());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'bad-signature' });
      expect(response.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
    }

    const expired = await signedFilesUrl({
      folders: [GAME],
      repoPath: 'games/snake/app.js',
      exp: futureExp(-30 * 86_400),
    });
    const response = await worker.fetch(new Request(expired), env, fakeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'expired' });
  });

  it('403s a validly signed grant that could not have been minted', async () => {
    const unsorted = btoa(`slides/intro\t${DECK_TREE}\ngames/snake\t${TREE_SHA}`)
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const url = await signedFilesUrl({
      folders: [GAME],
      grant: unsorted,
      repoPath: 'games/snake/app.js',
    });
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'malformed' });
  });

  it('serves a grant of several folders from each of them', async () => {
    const folders = [GAME, DECK];
    expect((await fetchFile('games/snake/app.js', { folders })).response.status).toBe(200);
    expect((await fetchFile('slides/intro/blocks/b1.html', { folders })).response.status).toBe(200);
    expect((await fetchFile('slides/intro/deck.json', { folders })).response.status).toBe(404);
  });

  it('fetches a cold tree and blob from the origin and caches both', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/content/token')) {
        return new Response(
          JSON.stringify({
            org: 'classmoji',
            repo: 'content-cs1',
            token: 'ghs_x',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          })
        );
      }
      if (url.includes(`/git/trees/${TREE_SHA}`)) {
        return new Response(
          JSON.stringify({ tree: [{ path: 'app.js', sha: sha('5'), type: 'blob' }] })
        );
      }
      if (url.includes(`/git/blobs/${sha('5')}`)) return new Response('go()');
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const bucket = fakeBucket();
    const ctx = fakeContext();
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/app.js' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('go()');
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([
      `trees/${TREE_SHA}.json`,
      `blobs/${sha('5')}`,
    ]);
  });

  it('boxes a cold HTML file pulled from the origin and still caches the original bytes', async () => {
    const html = '<!doctype html><h1>cold</h1>';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/content/token')) {
        return new Response(
          JSON.stringify({
            org: 'classmoji',
            repo: 'content-cs1',
            token: 'ghs_x',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          })
        );
      }
      if (url.includes('/git/blobs/')) {
        return new Response(html, { headers: { 'Content-Length': String(html.length) } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const bucket = fakeBucket(
      { [`trees/${TREE_SHA}.json`]: { body: listing({ 'index.html': { sha: sha('1') } }) } },
      { originDeclaresLength: true }
    );
    const ctx = fakeContext();
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/index.html' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );
    expect(await response.text()).toBe(`<!doctype html>${STORAGE_SHIM}<h1>cold</h1>`);
    await ctx.settled();
    expect(bucket.puts).toEqual([
      expect.objectContaining({ key: `blobs/${sha('1')}`, bytes: html.length }),
    ]);
  });
});

describe('files delivery from Gitlab', () => {
  const API = 'https://gitlab.example.edu/api/v4/projects/dept%2Fcontent-cs1';

  function stubGitlab(options: { pages?: 'one' | 'endless' } = {}) {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/content/token')) {
        return new Response(
          JSON.stringify({
            org: 'dept',
            repo: 'content-cs1',
            token: 'glpat-x',
            provider: 'GITLAB',
            apiBase: 'https://gitlab.example.edu',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          })
        );
      }
      if (url.startsWith(`${API}/repository/tree`)) {
        const params = new URL(url).searchParams;
        if (!params.get('recursive')) {
          return new Response(
            JSON.stringify([{ id: TREE_SHA, name: 'snake', type: 'tree', path: 'games/snake' }])
          );
        }
        const page = JSON.stringify([
          { id: sha('5'), name: 'app.js', type: 'blob', path: 'games/snake/app.js' },
        ]);
        if (options.pages === 'endless') {
          return new Response(page, {
            headers: { link: `<${API}/repository/tree?recursive=true&page_token=n>; rel="next"` },
          });
        }
        return new Response(page);
      }
      if (url === `${API}/repository/blobs/${sha('5')}/raw`) return new Response('go()');
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    return calls;
  }

  it('lists the granted folder by path and serves the file', async () => {
    const calls = stubGitlab();
    const bucket = fakeBucket();
    const ctx = fakeContext();
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/app.js' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('go()');
    const listed = calls
      .filter(call => call.includes('/repository/tree'))
      .map(call => new URL(call).searchParams.get('path'));
    expect(listed).toEqual(['games', 'games/snake']);
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([
      `trees/${TREE_SHA}.json`,
      `blobs/${sha('5')}`,
    ]);
  });

  it('serves a listing cut short at the page cap but never caches it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubGitlab({ pages: 'endless' });
    const bucket = fakeBucket();
    const ctx = fakeContext();
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/app.js' });
    const response = await worker.fetch(
      new Request(url),
      fakeEnv({ CACHE: bucket as unknown as R2Bucket }),
      ctx
    );
    expect(response.status).toBe(200);
    await ctx.settled();
    expect(bucket.puts.map(put => put.key)).toEqual([`blobs/${sha('5')}`]);
  });
});

describe('files logging', () => {
  it('logs a refused files URL without its signature, grant or query', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await signedFilesUrl({
      folders: [GAME],
      repoPath: 'games/snake/app.js',
      master: 'not-the-master',
    });
    const grant = encodeFilesGrant([GAME]);
    const [, policy] = /\/files\/[^/]+\/([^/]+)\//.exec(url) ?? [];
    const sig = policy.split('.')[3];

    const response = await worker.fetch(
      new Request(`${url}?p=secretp&v=secretv&token=secretvalue`),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(403);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('bad-signature');
    expect(message).toContain(`classroom=${CLASSROOM}`);
    expect(message).toContain('/month.1.…/games/snake/app.js');
    expect(message).not.toContain(sig);
    expect(message).not.toContain(grant);
    expect(message).not.toContain('secret');
  });

  it('logs a refused theme URL without its signature', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await signedThemeUrl({
      theme: 'aurora',
      treeSha: TREE_SHA,
      relPath: 'css/site.css',
      master: 'not-the-master',
    });
    const sig = /\/month\.1\.\d+\.([^/]+)\//.exec(url)?.[1] ?? '';
    expect(sig).not.toBe('');
    const response = await worker.fetch(new Request(url), fakeEnv(), fakeContext());
    expect(response.status).toBe(403);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(`/theme/aurora/${TREE_SHA}/month.1.…/css/site.css`);
    expect(message).not.toContain(sig);
  });

  it('logs a previous-key files URL without its signature', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = await signedFilesUrl({ folders: [GAME], repoPath: 'games/snake/app.js' });
    const env = fakeEnv({
      CACHE: warmBucket() as unknown as R2Bucket,
      CONTENT_SIGNING_SECRET: 'the-rotated-in-master-secret',
      CONTENT_SIGNING_SECRET_PREVIOUS: MASTER,
    });
    const response = await worker.fetch(new Request(`${url}?q=secretvalue`), env, fakeContext());
    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('key=previous');
    expect(message).not.toContain(encodeFilesGrant([GAME]));
    expect(message).not.toContain(/\.([^./]+)\/games/.exec(url)?.[1] ?? 'unreachable');
    expect(message).not.toContain('secretvalue');
  });
});

describe('preview frame', () => {
  it('serves a static boxed page without needing a signature or secrets', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/preview-frame`),
      fakeEnv({ CONTENT_SIGNING_SECRET: undefined }),
      fakeContext()
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toBe(BOX_CONTENT_SECURITY_POLICY);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toBe(PREVIEW_FRAME_HTML);
  });

  it('answers HEAD with no body', async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/preview-frame`, { method: 'HEAD' }),
      fakeEnv(),
      fakeContext()
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });

  it('has one script and nothing in it the HTML parser could read as markup', () => {
    const scripts = PREVIEW_FRAME_HTML.match(/<script>([\s\S]*?)<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    const script = (scripts[0] ?? '').slice('<script>'.length, -'</script>'.length);
    expect(script).not.toMatch(/<!--|<\/script|<script/i);
  });

  /** Run the frame's script against a stand-in window and document. */
  function runFrame() {
    const script = /<script>([\s\S]*?)<\/script>/.exec(PREVIEW_FRAME_HTML)?.[1] ?? '';
    const posted: Array<[unknown, string]> = [];
    const written: string[] = [];
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = {
      postMessage: (data: unknown, origin: string) => posted.push([data, origin]),
    };
    const window = {
      parent,
      addEventListener: (type: string, listener: typeof onMessage) => {
        if (type === 'message') onMessage = listener;
      },
    };
    const document = {
      open: () => written.push('open'),
      write: (html: string) => written.push(html),
      close: () => written.push('close'),
    };
    new Function('window', 'document', 'URL', script)(window, document, URL);
    return {
      posted,
      written,
      parent,
      send: (source: unknown, data: unknown) => onMessage?.({ source, data }),
    };
  }

  it('tells its parent it is ready, carrying no data', () => {
    const frame = runFrame();
    expect(frame.posted).toEqual([[{ type: 'cm-preview-ready' }, '*']]);
  });

  it('writes the first preview its parent sends, shim after the doctype', () => {
    const frame = runFrame();
    frame.send({}, { type: 'cm-preview', html: '<p>from elsewhere</p>' });
    frame.send(frame.parent, { type: 'other', html: '<p>wrong type</p>' });
    frame.send(frame.parent, { type: 'cm-preview', html: 42 });
    expect(frame.written).toEqual([]);

    frame.send(frame.parent, { type: 'cm-preview', html: '<!-- c --><!DOCTYPE html><p>hi</p>' });
    expect(frame.written).toEqual([
      'open',
      `<!-- c --><!DOCTYPE html>${STORAGE_SHIM}<p>hi</p>`,
      'close',
    ]);

    frame.send(frame.parent, { type: 'cm-preview', html: '<p>second</p>' });
    expect(frame.written).toHaveLength(3);
  });

  it('puts the shim first without a doctype, and adds an http(s) base only', () => {
    const plain = runFrame();
    plain.send(plain.parent, { type: 'cm-preview', html: '<p>x</p>', base: 'javascript:alert(1)' });
    expect(plain.written[1]).toBe(`${STORAGE_SHIM}<p>x</p>`);

    const based = runFrame();
    based.send(based.parent, {
      type: 'cm-preview',
      html: '<p>x</p>',
      base: 'https://content.example/c/x/files/g/p/slides/a/blocks/?a=1&b="2"',
    });
    expect(based.written[1]).toBe(
      `${STORAGE_SHIM}<base href="https://content.example/c/x/files/g/p/slides/a/blocks/?a=1&amp;b=%222%22"><p>x</p>`
    );
  });
});

describe('shimOffset', () => {
  const at = (text: string) => shimOffset(new TextEncoder().encode(text));

  it('lands after a doctype in any case, past whitespace and comments', () => {
    expect(at('<!doctype html><p>')).toBe(15);
    expect(at('  \n<!DocType html>x')).toBe(18);
    expect(at('<!-- a --><!-- b -->\n<!DOCTYPE html>')).toBe(36);
  });

  it('lands at the start otherwise', () => {
    expect(at('<html>')).toBe(0);
    expect(at('<!-- never closed <!doctype html>')).toBe(0);
    expect(at('<!doctype html')).toBe(0);
    expect(at('')).toBe(0);
  });
});
