import * as path from 'path';
import { fileURLToPath } from 'url';

import { test, expect } from '@playwright/test';
import { matchRoutes, type RouteObject } from 'react-router';

/**
 * The class-site route tree's SHAPE, asserted against the real `app/routes.ts`.
 *
 * ── What this is protecting ────────────────────────────────────────────────
 * A URL on a course site with two or more segments — the real one that started
 * this, `cs52.classmoji.io/dartmouth-cs52-26f/forms/cs52-waitlist` — matched no
 * route at all. React Router's built-in 404 then bubbled past the site layout
 * to the ROOT error boundary, which renders "This page is unavailable / Try
 * again in a moment.": a mistyped link dressed up as an outage.
 *
 * The fix is a splat inside the layout (`site/not-found.tsx`) that throws the
 * same 404 a missing page slug throws, so the layout's boundary — the one that
 * already knows how to say "there's nothing here" — handles both.
 *
 * A splat that ranks even one point too high would silently eat `:pageSlug` or
 * the `forms/*` bridge, and nothing else in the suite would notice: the site
 * would just start 404ing pages that exist. So this file matches REAL paths
 * against the REAL config rather than re-deriving React Router's scoring.
 *
 * ── Why the private global ─────────────────────────────────────────────────
 * `app/routes.ts` calls `flatRoutes()`, which reads the app directory from
 * `globalThis.__reactRouterAppDirectory` — a variable the dev server sets and
 * nothing else does. Setting it here is what makes the route config importable
 * outside a build. It is React Router internals; if this import ever starts
 * failing, that is the thing to look at first.
 */

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
(globalThis as unknown as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory =
  APP_DIR;

const routeConfig = (await import('../../app/routes.ts')).default;

type ConfigEntry = {
  path?: string;
  index?: boolean;
  file: string;
  children?: ConfigEntry[];
};

/** The route config, in the shape `matchRoutes` reads. `file` rides along as the id. */
const toRouteObjects = (entries: ConfigEntry[]): RouteObject[] =>
  entries.map(entry => ({
    path: entry.path,
    index: entry.index,
    id: entry.file,
    children: entry.children ? toRouteObjects(entry.children) : undefined,
  })) as RouteObject[];

const routes = toRouteObjects(routeConfig as unknown as ConfigEntry[]);

/** Every route module in the match, outermost first. */
const chainFor = (pathname: string): string[] => {
  const matches = matchRoutes(routes, pathname);
  expect(matches, `${pathname} should match something`).toBeTruthy();
  return matches!.map(m => m.route.id!);
};

/** The module that actually answers a request. */
const leafFor = (pathname: string): string => {
  const chain = chainFor(pathname);
  return chain[chain.length - 1];
};

const SITE = '/_site/cs52';

test.describe('the class-site route tree', () => {
  test('a multi-segment address lands on the not-found route, inside the layout', () => {
    // The exact production URL from the bug report.
    const chain = chainFor(`${SITE}/dartmouth-cs52-26f/forms/cs52-waitlist`);

    expect(chain[chain.length - 1]).toBe('site/not-found.tsx');
    // Inside the layout is the whole point: the layout's ErrorBoundary is what
    // renders the branded 404. A splat declared as a sibling of the layout
    // would still return 404 — with the root boundary's outage copy.
    expect(chain).toContain('site/layout.tsx');
  });

  test('deeper and stranger addresses land there too', () => {
    for (const pathname of [
      `${SITE}/a/b`,
      `${SITE}/a/b/c/d`,
      `${SITE}/schedule/nope`,
      `${SITE}/robots.txt/nope`,
    ]) {
      expect(leafFor(pathname), pathname).toBe('site/not-found.tsx');
    }
  });

  test('the splat never shadows a real page slug', () => {
    // Single-segment slugs — the ones an instructor authors — must keep
    // reaching page.tsx, which does the real lookup and 404s on its own terms.
    // React Router's `splatPenalty` is what guarantees this regardless of
    // declaration order; assert it rather than trust it.
    expect(leafFor(`${SITE}/no-such-page`)).toBe('site/page.tsx');
    expect(leafFor(`${SITE}/syllabus`)).toBe('site/page.tsx');
  });

  test('the splat never shadows the static siblings', () => {
    expect(leafFor(`${SITE}`)).toBe('site/home.tsx');
    expect(leafFor(`${SITE}/`)).toBe('site/home.tsx');
    expect(leafFor(`${SITE}/sign-in`)).toBe('site/sign-in.tsx');
    expect(leafFor(`${SITE}/schedule`)).toBe('site/schedule.tsx');
    expect(leafFor(`${SITE}/app`)).toBe('site/app.tsx');
    expect(leafFor(`${SITE}/robots.txt`)).toBe('site/robots.ts');
  });

  test('the forms short-link bridge still outranks the splat', () => {
    // Both are splats; `forms/*` carries one more static segment and so scores
    // higher. If this ever flipped, every short link shared on a course site
    // would 404 instead of bridging.
    expect(leafFor(`${SITE}/forms/cs52-waitlist`)).toBe('site/forms.ts');
    expect(leafFor(`${SITE}/forms/cs52-waitlist/verify`)).toBe('site/forms.ts');
    expect(leafFor(`${SITE}/forms`)).toBe('site/forms.ts');
  });
});

test.describe('the not-found route module', () => {
  test('its loader throws a 404 carrying the site headers', async () => {
    const { loader } = await import('../../app/site/not-found.tsx');

    const request = new Request('https://cs52.classmoji.io/_site/cs52/a/b');
    let thrown: unknown;
    try {
      // The loader reads nothing but `request`, so the rest of the route args
      // would be dead weight here.
      await (loader as unknown as (args: { request: Request }) => unknown)({ request });
    } catch (error) {
      thrown = error;
    }

    expect(thrown, 'the loader must throw, never return').toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(404);
    // Same `error.data` page.tsx throws, so the layout's boundary renders ONE
    // not-found for both a missing page and an unmatched address.
    expect(await response.text()).toBe('missing');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });

  test('it exports a component, which is what routes the throw to the boundary', async () => {
    // Not decoration. React Router's server treats a leaf whose module exports
    // neither `default` nor `ErrorBoundary` as a RESOURCE request and returns
    // the thrown Response verbatim — a bare `text/plain` "missing" instead of
    // the branded 404 document. Deleting the component to "make it a resource
    // route like robots.ts" would silently undo the fix; this is the tripwire.
    const mod = await import('../../app/site/not-found.tsx');
    expect(typeof mod.default).toBe('function');
  });
});
