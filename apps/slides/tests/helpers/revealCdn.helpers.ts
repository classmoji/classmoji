/**
 * Serve a generated deck document in the browser tests, with its jsDelivr
 * URLs (`/npm/<pkg>@<version>/<path>`) answered from the INSTALLED packages:
 * the reveal.js engine the document names is the one in node_modules, and the
 * tests need no network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';

const requireFromHere = createRequire(import.meta.url);

/** `/npm/<pkg>@<version>/<path>` → the installed package's file, or null. */
export function installedCdnFile(pathname: string): string | null {
  const m = pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/);
  if (!m) return null;
  let root: string;
  try {
    // The entry point, then up to the package's own folder (`exports` hides package.json).
    root = dirname(requireFromHere.resolve(m[1]));
  } catch {
    return null;
  }
  while (!existsSync(join(root, 'package.json'))) root = dirname(root);
  const file = join(root, m[2]);
  return existsSync(file) ? file : null;
}

/** Answer `https://cdn.jsdelivr.net/npm/…` from node_modules (404 for anything else). */
export async function routeJsdelivrToInstalled(page: Page): Promise<void> {
  await page.route('https://cdn.jsdelivr.net/**', async routed => {
    const file = installedCdnFile(new URL(routed.request().url()).pathname);
    if (!file) return routed.fulfill({ status: 404, body: '' });
    const contentType = file.endsWith('.css') ? 'text/css' : 'text/javascript';
    return routed.fulfill({ contentType, body: readFileSync(file) });
  });
}
