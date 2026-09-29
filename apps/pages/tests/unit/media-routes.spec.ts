import { readFileSync } from 'node:fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { test, expect } from '@playwright/test';
import { matchRoutes, type RouteObject } from 'react-router';

/**
 * The six media endpoints the upload client talks to, mounted on the pages
 * origin.
 *
 * `uploadMultipart` posts to whichever origin its editor runs on, so the pages
 * app has to answer the same six paths the webapp does — and with the SAME
 * handlers, which live once in `@classmoji/auth/media-http`. What this pins:
 *
 *  - each path reaches the route file meant for it (the static `uploads` and
 *    `list` segments outrank `$mediaId`, and the `uploads_` underscore keeps
 *    the per-upload routes from nesting under the create route);
 *  - each file is a re-export of the shared handler and nothing else, so the
 *    pages app cannot drift into answering a refusal differently.
 *
 * Route matching uses the real `app/routes.ts`, the way `site-routes.spec.ts`
 * does (see there for the private global).
 */

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
(globalThis as unknown as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory =
  APP_DIR;

const routeConfig = (await import('../../app/routes.ts')).default;

type ConfigEntry = { path?: string; index?: boolean; file: string; children?: ConfigEntry[] };

const toRouteObjects = (entries: ConfigEntry[]): RouteObject[] =>
  entries.map(entry => ({
    path: entry.path,
    index: entry.index,
    id: entry.file,
    children: entry.children ? toRouteObjects(entry.children) : undefined,
  })) as RouteObject[];

const routes = toRouteObjects(routeConfig as unknown as ConfigEntry[]);

const leafFor = (pathname: string): string => {
  const matches = matchRoutes(routes, pathname);
  expect(matches, `${pathname} should match something`).toBeTruthy();
  return matches![matches!.length - 1].route.id!;
};

const ID = '0b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';

const MOUNTS: Array<{ pathname: string; dir: string; exported: string }> = [
  {
    pathname: '/api/media/uploads',
    dir: 'api.media.uploads',
    exported: 'export { mediaUploadsAction as action }',
  },
  {
    pathname: `/api/media/uploads/${ID}/parts`,
    dir: 'api.media.uploads_.$mediaId.parts',
    exported: 'export { mediaPartsAction as action }',
  },
  {
    pathname: `/api/media/uploads/${ID}/complete`,
    dir: 'api.media.uploads_.$mediaId.complete',
    exported: 'export { mediaCompleteAction as action }',
  },
  {
    pathname: `/api/media/uploads/${ID}/abort`,
    dir: 'api.media.uploads_.$mediaId.abort',
    exported: 'export { mediaAbortAction as action }',
  },
  {
    pathname: `/api/media/${ID}`,
    dir: 'api.media.$mediaId',
    exported: 'export { mediaDeleteAction as action }',
  },
  {
    pathname: '/api/media/list',
    dir: 'api.media.list',
    exported: 'export { mediaListLoader as loader }',
  },
];

test("/api/media-url, the pages app's own resolve, is mounted beside them", () => {
  expect(leafFor('/api/media-url')).toBe('routes/api.media-url/route.ts');
});

test.describe('the media routes on the pages origin', () => {
  for (const mount of MOUNTS) {
    test(`${mount.pathname} reaches ${mount.dir}`, () => {
      expect(leafFor(mount.pathname)).toBe(`routes/${mount.dir}/route.ts`);
    });

    test(`${mount.dir} re-exports the shared handler and nothing else`, () => {
      const source = readFileSync(path.join(APP_DIR, 'routes', mount.dir, 'route.ts'), 'utf8');
      const code = source
        .split('\n')
        .filter(line => line.trim() && !line.trim().startsWith('//'))
        .join('\n');
      expect(code).toBe(`${mount.exported} from '@classmoji/auth/media-http';`);
    });
  }
});
