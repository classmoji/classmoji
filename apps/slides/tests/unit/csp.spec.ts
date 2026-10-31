/**
 * Content-Security-Policy: app documents and generated deck documents.
 *
 * App documents go through the real entry.server.tsx inside React Router's
 * own request handler, with a stand-in build whose root reads the nonce the
 * way app/root.tsx does (root.tsx itself pulls in CSS and the browser SDK, so
 * its wiring is checked from source). Every script the document carries must
 * hold the nonce the header names, on a page and on the error document.
 *
 * Generated documents: every inline script the response carries must be
 * allowed by hash, byte for byte, and a real Chrome must run them under the
 * header while refusing any other inline script.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import {
  Links,
  Outlet,
  Scripts,
  ScrollRestoration,
  createRequestHandler,
  type ServerBuild,
} from 'react-router';
import { load } from 'cheerio';
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { generateDeckHtml, type DeckJson } from '@classmoji/services/slides';
import { VIEW_API_GLOBAL } from '@classmoji/services/render-contract';
import { THUMBNAIL_READY_ATTRIBUTE } from '@classmoji/services/deck-thumbnail-contract';
import { sanitizeDeckDocumentServer } from '@classmoji/services/slides/safe-markup/server';
import * as entry from '../../app/entry.server.tsx';
import { useNonce } from '../../app/utils/cspNonce.ts';
import {
  CSP_HEADER,
  CSP_REPORT_ONLY_HEADER,
  appContentSecurityPolicy,
  contentDeliveryOrigin,
  framedBySelfOnly,
  generatedDocContentSecurityPolicy,
  generatedDocCspHeaders,
} from '../../app/utils/csp.server.ts';
import { VIEW_DOC_SCRIPTS, withViewScript } from '../../app/utils/deckView.server.ts';
import {
  READINESS_DOC_SCRIPTS,
  withReadinessMarker,
} from '../../app/routes/$slideId_.thumbnail-source/route.tsx';

const ENV_KEYS = [
  'NODE_ENV',
  'WEBAPP_URL',
  'SLIDES_URL',
  'CONTENT_DELIVERY_ORIGIN',
  'COLLAB_URL',
  'COLLAB_WS_URL',
] as const;
let savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.NODE_ENV = 'production';
  process.env.WEBAPP_URL = 'https://classmoji.test';
  process.env.SLIDES_URL = 'https://slides.classmoji.test';
  process.env.CONTENT_DELIVERY_ORIGIN = 'https://content.classmoji.test/';
  process.env.COLLAB_URL = 'https://collab.classmoji.test';
  process.env.COLLAB_WS_URL = 'wss://collab.classmoji.test';
});

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─── App documents ──────────────────────────────────────────────────────────

/** A document shell wired the way app/root.tsx wires its two documents. */
function Shell({ children }: { children: ReactNode }) {
  const nonce = useNonce();
  return createElement(
    'html',
    null,
    createElement(
      'head',
      null,
      createElement('meta', { property: 'csp-nonce', nonce }),
      createElement(Links, { nonce })
    ),
    createElement(
      'body',
      null,
      children,
      createElement('script', { nonce, dangerouslySetInnerHTML: { __html: 'void 0;' } }),
      createElement(ScrollRestoration, { nonce }),
      createElement(Scripts, { nonce })
    )
  );
}

/** React Router's request handler over the real entry, without a database. */
function handler() {
  const routeAssets = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    module: `/assets/${id}.js`,
    imports: [],
    css: [],
    hasAction: false,
    hasLoader: false,
    hasClientAction: false,
    hasClientLoader: false,
    hasClientMiddleware: false,
    hasErrorBoundary: false,
    ...extra,
  });
  const build = {
    entry: { module: entry },
    routes: {
      root: {
        id: 'root',
        path: '',
        module: {
          default: () => createElement(Shell, null, createElement(Outlet)),
          ErrorBoundary: () => createElement(Shell, null, 'Something went wrong'),
        },
      },
      deck: {
        id: 'deck',
        parentId: 'root',
        path: ':slideId/present',
        module: { default: () => createElement('p', null, 'deck') },
      },
    },
    assets: {
      entry: { module: '/assets/entry.client.js', imports: ['/assets/chunk.js'] },
      routes: {
        root: routeAssets('root', { path: '', hasErrorBoundary: true }),
        deck: routeAssets('deck', { parentId: 'root', path: ':slideId/present' }),
      },
      url: '/assets/manifest.js',
      version: 'test',
    },
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'lazy', manifestPath: '/__manifest' },
  } as unknown as ServerBuild;
  return createRequestHandler(build, 'production');
}

function nonceOf(policy: string | null): string {
  const match = /'nonce-([^']+)'/.exec(policy ?? '');
  if (!match) throw new Error(`no nonce in ${policy}`);
  return match[1];
}

async function expectEveryScriptNonced(response: Response) {
  const policy = response.headers.get(CSP_HEADER);
  const nonce = nonceOf(policy);
  const html = await response.text();
  const $ = load(html);
  const scripts = $('script').toArray();
  // Module scripts, the dark-mode script, scroll restoration, the context.
  expect(scripts.length).toBeGreaterThan(2);
  for (const script of scripts) {
    const type = $(script).attr('type');
    if (type === 'application/json') continue;
    expect($(script).attr('nonce'), $.html(script).slice(0, 120)).toBe(nonce);
  }
  expect($('meta[property="csp-nonce"]').attr('nonce')).toBe(nonce);
  return { policy: policy as string, nonce };
}

test.describe('app documents', () => {
  test('every script carries the nonce the enforced header names', async () => {
    const response = await handler()(new Request('https://slides.classmoji.test/abc/present'));
    expect(response.status).toBe(200);
    expect(response.headers.get(CSP_REPORT_ONLY_HEADER)).toBeNull();
    const { policy } = await expectEveryScriptNonced(response);
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("frame-ancestors 'self'");
  });

  test('the error document (no matching route) is nonced too', async () => {
    const response = await handler()(new Request('https://slides.classmoji.test/a/b/c/d/e'));
    expect(response.status).toBe(404);
    await expectEveryScriptNonced(response);
  });

  test('a fresh nonce per document', async () => {
    const run = handler();
    const a = await run(new Request('https://slides.classmoji.test/abc/present'));
    const b = await run(new Request('https://slides.classmoji.test/abc/present'));
    const nonceA = nonceOf(a.headers.get(CSP_HEADER));
    expect(nonceA).not.toBe(nonceOf(b.headers.get(CSP_HEADER)));
    expect(Buffer.from(nonceA, 'base64')).toHaveLength(16);
  });

  test('outside production the same policy is Report-Only', async () => {
    process.env.NODE_ENV = 'development';
    const response = await handler()(new Request('http://localhost:6570/abc/present'));
    expect(response.headers.get(CSP_HEADER)).toBeNull();
    const policy = response.headers.get(CSP_REPORT_ONLY_HEADER) ?? '';
    expect(policy).toContain("'nonce-");
    expect(policy).toMatch(/connect-src [^;]*ws:\/\/localhost:\*/);
  });
});

test.describe('app/root.tsx', () => {
  const ROOT = readFileSync(fileURLToPath(new URL('../../app/root.tsx', import.meta.url)), 'utf8');
  const count = (needle: string) => ROOT.split(needle).length - 1;

  test('both documents (App and ErrorBoundary) read the nonce and hand it on', () => {
    expect(count('const nonce = useNonce();')).toBe(2);
    expect(count('<Scripts nonce={nonce} />')).toBe(2);
    expect(count('<Links nonce={nonce} />')).toBe(2);
    expect(count('<CspNonceMeta nonce={nonce} />')).toBe(2);
    expect(count('<ScrollRestoration nonce={nonce} />')).toBe(1);
    expect(ROOT).not.toMatch(/<Scripts \/>|<Links \/>|<ScrollRestoration \/>/);
  });

  test('its one inline script carries the nonce', () => {
    const inline = ROOT.match(/<script\b(?![^>]*type="application\/json")[^>]*?>/gs) ?? [];
    expect(inline.length).toBeGreaterThan(0);
    for (const tag of inline) expect(tag).toContain('nonce={nonce}');
  });
});

test.describe('the app policy', () => {
  const policyFor = (path: string) =>
    appContentSecurityPolicy({ nonce: 'N', url: new URL(path, 'https://slides.classmoji.test') });

  test('editor, presenter and speaker documents are framed by the slides origin only', () => {
    for (const path of ['/abc?mode=edit', '/abc/present', '/abc/present?saved=1', '/abc/speaker']) {
      expect(policyFor(path), path).toContain("frame-ancestors 'self'");
    }
  });

  test('the viewer and follow documents stay embeddable', () => {
    for (const path of ['/abc', '/abc?preview=1', '/abc/follow', '/abc/follow?preview=true', '/']) {
      expect(policyFor(path), path).not.toContain('frame-ancestors');
    }
    expect(framedBySelfOnly(new URL('https://s.test/org/abc?mode=edit'))).toBe(false);
  });

  test('names the app’s own origins and nothing local in production', () => {
    const policy = policyFor('/abc');
    expect(policy).toBe(
      [
        "default-src 'self'",
        "script-src 'nonce-N' 'strict-dynamic' https: 'unsafe-inline'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self' https://classmoji.test",
        "frame-src 'self' https: https://content.classmoji.test https://classmoji.test",
        "worker-src 'self' blob:",
        "connect-src 'self' wss://slides.classmoji.test wss://collab.classmoji.test https:",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "style-src 'self' 'unsafe-inline' https:",
        "font-src 'self' data: https:",
      ].join('; ')
    );
  });

  test('the content origin is read as an origin, or not at all', () => {
    expect(contentDeliveryOrigin({ CONTENT_DELIVERY_ORIGIN: 'https://c.test/x/' })).toBe(
      'https://c.test'
    );
    expect(contentDeliveryOrigin({ CONTENT_DELIVERY_ORIGIN: 'not a url' })).toBeNull();
    expect(contentDeliveryOrigin({})).toBeNull();
  });
});

// ─── Generated documents ────────────────────────────────────────────────────

const DECK = {
  version: 1,
  theme: 'white',
  codeTheme: 'github',
  config: { transition: 'fade', width: 1280, height: 720 },
  slides: [
    {
      id: 'a',
      html: '<h1>A</h1><img src="x" onerror="window.__ran = true"><script>window.__ran = true</script>',
      notes: 'note',
    },
  ],
} as unknown as DeckJson;

const sha256 = (text: string) =>
  `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/** Every inline script that would run: no `src`, not a data block. */
function inlineScripts(html: string): string[] {
  const $ = load(html);
  return $('script')
    .toArray()
    .filter(el => !$(el).attr('src') && $(el).attr('type') !== 'application/json')
    .map(el => $(el).text());
}

/** The two documents as their routes emit them (after the read-side cleanup). */
function generatedDocuments() {
  const generated = sanitizeDeckDocumentServer(
    generateDeckHtml(DECK, { title: 'T', includeNotes: false, standalone: true })
  );
  const meta = { kind: 'deck', version: 'v', width: 1280, height: 720, slides: [] };
  return [
    {
      name: 'render-view',
      html: withViewScript(generated, meta as never),
      scripts: VIEW_DOC_SCRIPTS,
    },
    {
      name: 'thumbnail-source',
      html: withReadinessMarker(generated),
      scripts: READINESS_DOC_SCRIPTS,
    },
  ];
}

test.describe('generated documents', () => {
  test('every inline script is allowed by hash, byte for byte', () => {
    for (const doc of generatedDocuments()) {
      const policy = generatedDocContentSecurityPolicy(doc.scripts);
      const scripts = inlineScripts(doc.html);
      // The generator's init script and the route's own.
      expect(scripts, doc.name).toHaveLength(2);
      for (const text of scripts) expect(policy, doc.name).toContain(sha256(text));
      // Exactly those two hashes: nothing else is allowed inline.
      expect(policy.match(/'sha256-/g), doc.name).toHaveLength(2);
    }
  });

  test('the policy', () => {
    const policy = generatedDocContentSecurityPolicy(READINESS_DOC_SCRIPTS);
    expect(policy).toMatch(
      /^default-src 'none'; script-src 'sha256-[^']+' 'sha256-[^']+' https:\/\/cdn\.jsdelivr\.net;/
    );
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(generatedDocCspHeaders(READINESS_DOC_SCRIPTS)).toEqual({ [CSP_HEADER]: policy });
    expect(generatedDocCspHeaders(READINESS_DOC_SCRIPTS, { NODE_ENV: 'development' })).toEqual({
      [CSP_REPORT_ONLY_HEADER]: policy,
    });
  });
});

// The browser checks drive the installed Chrome.
test.use({ channel: 'chrome' });

test.describe('generated documents in a browser', () => {
  const ORIGIN = 'https://cm-csp.test';

  test('Chrome runs the allowed scripts and nothing else', async ({ page }) => {
    for (const doc of generatedDocuments()) {
      const policy = generatedDocContentSecurityPolicy(doc.scripts);
      const violations: string[] = [];
      page.on('console', message => {
        if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
      });
      await page.route('https://cdn.jsdelivr.net/**', routed => {
        const path = new URL(routed.request().url()).pathname;
        if (path.endsWith('/reveal.js')) {
          return routed.fulfill({
            contentType: 'application/javascript',
            body: `window.Reveal = { initialize: function (c) { window.__config = c; window.__ready = true; },
              isReady: function () { return !!window.__ready; }, on: function (n, f) { f(); },
              configure: function () {}, layout: function () {} };`,
          });
        }
        if (path.endsWith('/highlight.js')) {
          return routed.fulfill({
            contentType: 'application/javascript',
            body: 'window.RevealHighlight = {};',
          });
        }
        return routed.fulfill({ contentType: 'text/css', body: '' });
      });
      await page.route(`${ORIGIN}/**`, routed =>
        routed.fulfill({
          contentType: 'text/html',
          headers: { [CSP_HEADER]: policy },
          body: doc.html,
        })
      );
      await page.goto(`${ORIGIN}/${doc.name}`);
      // The generator's init script ran (it read its JSON config).
      await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready);
      expect(
        await page.evaluate(
          () => (window as unknown as { __config: { transition: string } }).__config
        )
      ).toMatchObject({ transition: 'fade', width: 1280 });
      // The route's own script ran.
      if (doc.name === 'thumbnail-source') {
        await page.waitForSelector(`[${THUMBNAIL_READY_ATTRIBUTE}]`, { state: 'attached' });
      } else {
        await page.waitForFunction(api => api in window, VIEW_API_GLOBAL);
      }
      // A script the policy does not name is refused.
      const injected = await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__injected = true';
        document.body.appendChild(s);
        return (window as unknown as { __injected?: boolean }).__injected === true;
      });
      expect(injected, doc.name).toBe(false);
      expect(
        await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)
      ).toBeFalsy();
      expect(
        violations.filter(v => !/inline script/i.test(v)),
        doc.name
      ).toEqual([]);
      await page.unrouteAll();
    }
  });
});
