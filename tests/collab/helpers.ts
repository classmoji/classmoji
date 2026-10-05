import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, type BrowserContext, type Page } from '@playwright/test';
// Type-only: both packages build their Prisma client at import time, so the
// runtime imports below happen only after DATABASE_URL is settled.
import type getPrismaType from '@classmoji/database';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function devContext(): string {
  try {
    return fs.readFileSync(path.join(ROOT, '.dev-context'), 'utf8');
  } catch {
    return '';
  }
}

function fromDevContext(label: string, fallback: string): string {
  const match = devContext().match(new RegExp(`${label}:\\s+(http://localhost:\\d+)`));
  return match?.[1] ?? fallback;
}

export const WEBAPP_URL =
  process.env.WEBAPP_URL || fromDevContext('Webapp', 'http://localhost:3010');
export const PAGES_URL = process.env.PAGES_URL || fromDevContext('Pages', 'http://localhost:7110');
export const SLIDES_URL =
  process.env.SLIDES_URL || fromDevContext('Slides', 'http://localhost:6510');

type Prisma = ReturnType<typeof getPrismaType>;
let prisma: Prisma | null = null;

/** The devport database — refuses anything that is not localhost. */
export async function db(): Promise<Prisma> {
  if (!process.env.DATABASE_URL) {
    const match = devContext().match(/URL:\s+(postgresql:\/\/\S+)/);
    if (match) process.env.DATABASE_URL = match[1];
  }
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    throw new Error(`Refusing to run the collab suite against a non-local database (${url})`);
  }
  if (!prisma) {
    const { default: getPrisma } = await import('@classmoji/database');
    prisma = getPrisma();
  }
  return prisma;
}

/** The service layer, loaded after `db()` has settled DATABASE_URL. */
export async function services() {
  await db();
  return import('@classmoji/services');
}

/**
 * Sign a browser context in through `/test-login?as=<login>`. The request
 * runs on the context's own request client, so the Set-Cookie lands in the
 * context's jar without rendering the webapp dashboard. The cookie is
 * host-only `localhost`, which every dev port (webapp, pages, slides, collab)
 * receives.
 */
export async function signIn(context: BrowserContext, login: string): Promise<void> {
  const response = await context.request.get(
    `${WEBAPP_URL}/test-login?as=${encodeURIComponent(login)}&redirect=/`,
    { maxRedirects: 0 }
  );
  expect(response.status(), `test-login as ${login}`).toBe(302);
  const cookies = await context.cookies(WEBAPP_URL);
  expect(cookies.some(c => c.name.endsWith('.session_token'))).toBe(true);
}

/**
 * Open a live page or deck and wait until it reports `synced`. A dev-server
 * load can stall or fail to hydrate (seen when the browser reaches the stack
 * through this machine's own Tailscale address), so a stuck load is retried
 * with a reload rather than failing the test.
 */
export async function openLive(page: Page, url: string, attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (attempt === 1) await page.goto(url, { waitUntil: 'domcontentloaded' });
      else await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}
