/**
 * Shared helpers for the content-delivery end-to-end pack.
 *
 * ONE implementation, used by two Playwright projects. `apps/pages` and
 * `apps/slides` each own a `tests/helpers/` directory and each own a
 * `playwright.config.ts` whose `testDir` is its own `./tests`, so neither can
 * see the other's — and the delivery layer is exactly the thing both of them
 * have to make identical claims about. A second copy would drift, and the drift
 * would be invisible: two suites asserting slightly different URL shapes both
 * stay green while the app emits neither.
 *
 * It lives at the repo root rather than inside one app because reaching from
 * `apps/slides` into `apps/pages/tests` would make one app's internals another
 * app's dependency, which AGENTS.md rules out. Each app re-exports this from
 * its own `tests/helpers/index.ts`, so specs still import from the familiar
 * place.
 *
 * Nothing here is collected by either Playwright project (`testDir` is each
 * app's `./tests`), so this directory holds no specs and never will.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Locator, Page, Request } from '@playwright/test';
import {
  assertWritableDatabase,
  databaseHost,
  isLocalDatabaseHost,
  resolvedDatabaseUrl,
} from './databaseGuard.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

/**
 * Everything this pack creates is named with this prefix.
 *
 * A run leaves rows in a real database and, when a content repo is configured,
 * files in a real repository. The prefix is what makes the leftovers of a
 * killed run findable and safe to remove by hand — and what stops a cleanup
 * from ever matching something a human made.
 */
export const E2E_PREFIX = 'E2E CD';

/** A filesystem/repo-safe version of the same marker. */
export const E2E_SLUG_PREFIX = 'e2e-cd';

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

export type E2ETarget = 'local' | 'staging';

/**
 * Which deployment this run is pointed at. `local` unless asked otherwise.
 *
 * The default matters: a developer running `npm run e2e:content` with no env
 * set must not reach a deployed environment by accident, and a typo in the
 * variable must fail closed to local rather than open to staging.
 */
export function e2eTarget(): E2ETarget {
  return process.env.E2E_TARGET === 'staging' ? 'staging' : 'local';
}

/** `.dev-context` is written by `npm run dev`; a devport shifts every port. */
function devContext(): string | null {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, '.dev-context'), 'utf-8');
  } catch {
    return null;
  }
}

function devPort(label: 'Webapp' | 'Slides' | 'Pages'): string | null {
  const content = devContext();
  if (!content) return null;
  const match = content.match(new RegExp(`${label}:\\s+http://localhost:(\\d+)`));
  return match ? `http://localhost:${match[1]}` : null;
}

/** The dev database this checkout is actually using, per `.dev-context`. */
export function devDatabaseUrl(): string | null {
  const content = devContext();
  const match = content?.match(/URL:\s+(postgresql:\/\/\S+)/);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fail-open detector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many scenarios got far enough to assert something.
 *
 * The failure this exists for has already happened once: `npm run e2e:content`
 * reported two green tasks while every scenario skipped, because turbo did not
 * pass `E2E_CD_CONTENT_REPO` through and each skip looked individually
 * reasonable. A suite whose skips are all "correct" can still be worth nothing,
 * and nothing in a green summary says so. Each pack ends with a check on this
 * counter.
 */
let scenariosRun = 0;

/** Call once a scenario has reached its first real assertion. */
export function markScenarioRan(): void {
  scenariosRun += 1;
}

export function scenariosThatRan(): number {
  return scenariosRun;
}

// ─────────────────────────────────────────────────────────────────────────────
// Origin safety
// ─────────────────────────────────────────────────────────────────────────────

/** The only content origin a staging run may ever talk to. */
const STAGING_DELIVERY_ORIGIN = 'https://content-staging.classmoji.io';

/**
 * Hosts this pack must never be pointed at, however it is configured.
 *
 * The pack signs in, uploads, deletes and flips flags. Against production that
 * is not a bad test run, it is an incident — so production is refused at the
 * point the origin is resolved rather than trusted to be excluded by whichever
 * skip happens to fire first. The rule is positive: a `classmoji.io` host has
 * to SAY `staging` somewhere. `app.` and `content.` are named too, so the error
 * can be specific about the two that matter most.
 */
function assertSafeOrigin(label: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${JSON.stringify(raw)}`);
  }

  const host = url.hostname.toLowerCase();
  if (LOCAL_ORIGIN_HOSTS.has(host)) return raw;

  const named: Record<string, string> = {
    'app.classmoji.io': 'the production webapp',
    'content.classmoji.io': 'the production content Worker',
    'pages.classmoji.io': 'the production pages app',
    'slides.classmoji.io': 'the production slides app',
  };
  if (named[host]) {
    throw new Error(
      `${label} points at ${named[host]} (${host}). This pack uploads, deletes and changes ` +
        'classroom rows; it must never be aimed at production.'
    );
  }

  const isClassmoji = host === 'classmoji.io' || host.endsWith('.classmoji.io');
  if (isClassmoji && !host.includes('staging')) {
    throw new Error(
      `${label} points at '${host}', a classmoji.io host that is not a staging one. ` +
        'Only staging hosts are allowed; use E2E_TARGET=local for a local run.'
    );
  }

  return raw;
}

const LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * The delivery origin for a staging run, ignoring the environment entirely.
 *
 * `npm run e2e:content` runs under `dotenv -e .env`, and a local `.env` sets
 * `CONTENT_DELIVERY_ORIGIN=http://localhost:8787`. Read as an override, that
 * value silently redirected a staging run at a Worker on the developer's own
 * machine — which answers, and whose signatures are for a different host, so
 * the suite would have reported refusals as if staging had produced them. The
 * staging origin is therefore a constant, and a conflicting env value is
 * reported rather than obeyed.
 */
function stagingDeliveryOrigin(): string {
  const override = process.env.CONTENT_DELIVERY_ORIGIN;
  if (override && new URL(override).host !== new URL(STAGING_DELIVERY_ORIGIN).host) {
    console.warn(
      `[e2e] IGNORING CONTENT_DELIVERY_ORIGIN=${override} — a staging run always uses ` +
        `${STAGING_DELIVERY_ORIGIN}. (Your .env sets this for local work; that is expected.)`
    );
  }
  return STAGING_DELIVERY_ORIGIN;
}

export interface ContentDeliveryTargets {
  target: E2ETarget;
  /** Pages app — the page editor and the private page view. */
  pages: string;
  /** Slides app — the deck editor, viewer and `/present`. */
  slides: string;
  /** Webapp — classroom settings, and the Worker's token endpoint. */
  webapp: string;
  /** The public class site, where a `public` tier render is observable. */
  classSite: string;
  /** Where signed URLs point. MUST match what the apps signed for, port included. */
  deliveryOrigin: string;
  /** The classroom the pack works in. */
  classroomSlug: string;
}

/**
 * Resolve every base URL for this run.
 *
 * Local reads `.dev-context` so a devport works without configuration, and
 * every value stays overridable by env for the case `.dev-context` is stale —
 * which it silently is whenever a different worktree started the dev stack
 * last.
 */
export function targets(): ContentDeliveryTargets {
  const target = e2eTarget();

  if (target === 'staging') {
    return {
      target,
      pages: assertSafeOrigin(
        'E2E_PAGES_URL',
        process.env.E2E_PAGES_URL ?? 'https://pages.staging.classmoji.io'
      ),
      slides: assertSafeOrigin(
        'E2E_SLIDES_URL',
        process.env.E2E_SLIDES_URL ?? 'https://slides.staging.classmoji.io'
      ),
      webapp: assertSafeOrigin(
        'E2E_WEBAPP_URL',
        process.env.E2E_WEBAPP_URL ?? 'https://staging.classmoji.io'
      ),
      classSite: assertSafeOrigin(
        'E2E_CLASS_SITE_URL',
        process.env.E2E_CLASS_SITE_URL ?? 'https://cs98-test.staging.classmoji.io'
      ),
      // Deliberately NOT read from the environment. See stagingDeliveryOrigin.
      deliveryOrigin: stagingDeliveryOrigin(),
      classroomSlug: process.env.E2E_CLASSROOM_SLUG ?? 'cs98-test',
    };
  }

  return {
    target,
    pages: assertSafeOrigin(
      'E2E_PAGES_URL',
      process.env.E2E_PAGES_URL ?? devPort('Pages') ?? 'http://localhost:7100'
    ),
    slides: assertSafeOrigin(
      'E2E_SLIDES_URL',
      process.env.E2E_SLIDES_URL ?? devPort('Slides') ?? 'http://localhost:6500'
    ),
    webapp: assertSafeOrigin(
      'E2E_WEBAPP_URL',
      process.env.E2E_WEBAPP_URL ?? devPort('Webapp') ?? 'http://localhost:3000'
    ),
    // Locally the class site is served by the pages app on a host header it
    // cannot fake from Playwright, so the reachable surface is the same origin.
    classSite: assertSafeOrigin(
      'E2E_CLASS_SITE_URL',
      process.env.E2E_CLASS_SITE_URL ?? devPort('Pages') ?? 'http://localhost:7100'
    ),
    // A local run signs for, and probes, whatever the apps were started with —
    // but it still may not be a production host: an operator who exported the
    // production origin and forgot would otherwise aim the refusal probes there.
    deliveryOrigin: assertSafeOrigin(
      'CONTENT_DELIVERY_ORIGIN',
      process.env.CONTENT_DELIVERY_ORIGIN ?? 'http://localhost:8787'
    ),
    classroomSlug: process.env.E2E_CLASSROOM_SLUG ?? 'classmoji-dev-winter-2025',
  };
}

/** Host of the delivery origin, for request matching. */
export function deliveryHost(): string {
  return new URL(targets().deliveryOrigin).host;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skip gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why this run cannot exercise the delivery layer, or null when it can.
 *
 * A skip has to say which of the several ways to be half-configured happened.
 * "Delivery not configured" is useless when the four causes are a Worker that
 * is not running, a Worker running without secrets, a classroom whose flag is
 * off, and apps that were started without `CONTENT_SIGNING_SECRET` — the last
 * of which looks exactly like the flag being off from the browser's side.
 */
export async function deliverySkipReason(): Promise<string | null> {
  const { deliveryOrigin } = targets();

  const health = await workerHealth(deliveryOrigin);
  if (!health) {
    return (
      `no content Worker answering at ${deliveryOrigin}/healthz — ` +
      "start one with `npm run cf:dev:local -w apps/content` (see apps/content/README.md, 'Local end-to-end')"
    );
  }
  if (!health.configured) {
    return (
      `the Worker at ${deliveryOrigin} reports configured:false — ` +
      'CONTENT_SIGNING_SECRET / CONTENT_WORKER_SHARED_SECRET are missing from apps/content/.dev.vars'
    );
  }
  return null;
}

/**
 * Scenarios that need a Prisma client, to read the classroom or to write to it.
 *
 * The message says all three things a reader needs, because "local only" on its
 * own invites the wrong fix. This pack refuses to open a database connection
 * against a deployed target at all (see `prisma()` below), so the read-side
 * scenarios have no classroom row to work from; the write-side ones would be
 * changing a shared environment, where a cache-reset alone rewrites every URL
 * every real viewer is holding; and the editor scenarios need a session, which
 * staging cannot mint because `/test-login` does not exist outside development.
 */
export function localOnlySkipReason(): string | null {
  return e2eTarget() === 'staging'
    ? 'needs a database and a signed-in session, and this pack opens neither against a deployed target ' +
        '(no Prisma connection, no /test-login) — run with E2E_TARGET=local for this one'
    : null;
}

/**
 * Why a signed-in scenario cannot run, or null.
 *
 * `/test-login` is gated on `ENABLE_TEST_LOGIN` and mints a session by reading
 * the database, so it exists only where the tests can also reach Postgres.
 * Against a deployed target there is no such route and no seeded password —
 * the only way in would be a real session cookie handed to the run.
 */
export function authSkipReason(): string | null {
  if (e2eTarget() !== 'staging') return null;
  if (process.env.E2E_SESSION_COOKIE) return null;
  return (
    'staging has no test-login route and no seeded credentials: set E2E_SESSION_COOKIE to a ' +
    '`classmoji.session_token` value for a member of the target classroom, or run with E2E_TARGET=local'
  );
}

/** The session cookie name better-auth issues, and the one the apps read. */
const SESSION_COOKIE = 'classmoji.session_token';

/**
 * Sign a browser context in on a DEPLOYED target, using a real session token.
 *
 * Scoped to the three staging origins by URL and to nothing else. A cookie is
 * a live credential for a real account, so it is set per-origin rather than by
 * domain: a `.classmoji.io` domain cookie would be attached to production the
 * moment any redirect crossed over, which is the one thing this pack must never
 * do. `assertSafeOrigin` has already refused a production host by this point,
 * so the two checks compound.
 *
 * No-op unless the target is staging AND a token was supplied, so a local run
 * (which mints its own sessions through `/test-login`) is unaffected.
 */
export async function applyStagingSession(context: BrowserContext): Promise<boolean> {
  const token = process.env.E2E_SESSION_COOKIE;
  if (e2eTarget() !== 'staging' || !token) return false;

  const { pages, slides, classSite } = targets();
  await context.addCookies(
    [...new Set([pages, slides, classSite])].map(url => ({
      name: SESSION_COOKIE,
      value: token,
      url,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    }))
  );
  return true;
}

/** Is a signed-in staging run actually configured? */
export function hasStagingSession(): boolean {
  return e2eTarget() === 'staging' && Boolean(process.env.E2E_SESSION_COOKIE);
}

/**
 * The first content link on a classroom index, or null.
 *
 * Staging has no database to query for "a page this member can see", and
 * hard-coding an id would rot the first time someone tidied the classroom. The
 * index is the same list a member browses, so whatever it links to is by
 * definition something they may open.
 *
 * It says nothing about the page's VISIBILITY, though — it takes the first
 * link, public or members-only. A caller cannot infer a tier from what comes
 * back: the tier follows the content's visibility, so a public page here mints
 * `month` exactly as the class site does. Assert the shape of the URL, not
 * which tier it landed on.
 */
export async function discoverMemberContentUrl(
  page: Page,
  classroomSlug: string
): Promise<string | null> {
  await page.goto(`/${classroomSlug}`);
  await page.waitForLoadState('networkidle');
  const href = await page
    .locator(`a[href^="/${classroomSlug}/"]`)
    .first()
    .getAttribute('href')
    .catch(() => null);
  if (!href) return null;
  // `/new` is the create form, not content.
  return href.endsWith('/new') ? null : href;
}

/**
 * Why an upload scenario cannot run, or null.
 *
 * An upload writes a real file to a real GitHub repository through the
 * classroom's GitHub App installation. The seeded dev classroom points at
 * `dev-org/content-classmoji-dev-winter-2025`, which does not exist on GitHub,
 * so an upload there fails at the API call rather than telling you anything
 * about the delivery layer. `E2E_CD_CONTENT_REPO=1` is the operator's assertion
 * that the configured classroom's content repo is real and writable.
 */
export function uploadSkipReason(): string | null {
  if (process.env.E2E_CD_CONTENT_REPO === '1') return null;
  return (
    "no writable content repo: this scenario uploads to the classroom's GitHub content repo. " +
    'Point E2E_CLASSROOM_SLUG at a classroom whose repo really exists and whose org has the ' +
    'GitHub App installed, then set E2E_CD_CONTENT_REPO=1.'
  );
}

export interface WorkerHealth {
  ok: boolean;
  environment: string;
  configured: boolean;
}

/** `/healthz`, or null when nothing answers. Never throws. */
export async function workerHealth(origin: string): Promise<WorkerHealth | null> {
  try {
    const response = await fetch(`${origin.replace(/\/+$/, '')}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as WorkerHealth;
    return typeof body?.configured === 'boolean' ? body : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signed URL shape
// ─────────────────────────────────────────────────────────────────────────────

export type Tier = 'month' | 'week' | 'edit';

/** The three rungs `signSrcSet` emits. Mirrors TRANSFORM_WIDTHS. */
export const EXPECTED_WIDTHS = [800, 1600, 2560] as const;

/**
 * The `sizes` FALLBACK — mirrors `IMAGE_SIZES`.
 *
 * Not "the sizes constant every surface uses", which is the tempting and wrong
 * reading. It is what a surface emits when it does not know how wide the image
 * will be laid out. A block that carries `previewWidth` produces a better hint
 * from it (see `expectedSizesFor`), and that applies to the editor, the viewer
 * AND the class site — the difference is the BLOCK, not the surface.
 */
export const EXPECTED_SIZES = '(max-width: 1024px) 100vw, 1024px';

/** The `sizes` a block with this preview width should emit. Mirrors `imageSizesFor`. */
export function expectedSizesFor(previewWidth?: number | null): string {
  if (typeof previewWidth !== 'number' || !Number.isFinite(previewWidth) || previewWidth <= 0) {
    return EXPECTED_SIZES;
  }
  return `min(100vw, ${Math.round(previewWidth)}px)`;
}

/** The preview width `imageBlock` writes, so assertions can derive `sizes`. */
export const FIXTURE_PREVIEW_WIDTH = 512;

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * `/c/{uuid}/blob/{40-hex}.{ext}` — the path half of a signed blob URL.
 *
 * Shape only. NOTHING in this pack may assert a literal signature: a signature
 * is a function of a secret, a clock and an expiry bucket, so a test that
 * pinned one would be asserting the time of day. What is actually contractual
 * is the shape — the path, and which query keys are present.
 */
export const SIGNED_BLOB_PATH = new RegExp(`^/c/(${UUID})/blob/([0-9a-f]{40})\\.([a-z0-9]{1,8})$`);

/** `/c/{uuid}/missing/{encodedRef}` — the deterministic unresolvable URL. */
export const MISSING_PATH = new RegExp(`^/c/(${UUID})/missing/(.+)$`);

export interface SignedUrl {
  origin: string;
  classroomId: string;
  sha: string;
  ext: string;
  tier: Tier;
  keyVersion: number;
  exp: number;
  /** Present, never compared to a literal. */
  sig: string;
  w: number | null;
  fmt: string | null;
}

/** Parse a signed blob URL into its parts, or null when it is not one. */
export function parseSignedUrl(raw: string): SignedUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const match = SIGNED_BLOB_PATH.exec(url.pathname);
  if (!match) return null;

  const tier = url.searchParams.get('p');
  const keyVersion = url.searchParams.get('v');
  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  if (!tier || !keyVersion || !exp || !sig) return null;
  if (tier !== 'month' && tier !== 'week' && tier !== 'edit') return null;

  const w = url.searchParams.get('w');
  return {
    origin: url.origin,
    classroomId: match[1],
    sha: match[2],
    ext: match[3],
    tier,
    keyVersion: Number(keyVersion),
    exp: Number(exp),
    sig,
    w: w === null ? null : Number(w),
    fmt: url.searchParams.get('fmt'),
  };
}

/** Is this one of the resolver's `/missing/` placeholders? */
export function parseMissingUrl(raw: string): { classroomId: string; ref: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const match = MISSING_PATH.exec(url.pathname);
  if (!match) return null;
  return { classroomId: match[1], ref: decodeURIComponent(match[2]) };
}

export interface SrcSetCandidate {
  url: string;
  width: number;
  parsed: SignedUrl | null;
}

/** Split a `srcset` attribute into its candidates, preserving order. */
export function parseSrcSet(srcset: string | null): SrcSetCandidate[] {
  if (!srcset) return [];
  return srcset
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => {
      const lastSpace = entry.lastIndexOf(' ');
      const url = lastSpace === -1 ? entry : entry.slice(0, lastSpace);
      const descriptor = lastSpace === -1 ? '' : entry.slice(lastSpace + 1);
      return {
        url,
        width: Number.parseInt(descriptor.replace(/w$/, ''), 10),
        parsed: parseSignedUrl(url),
      };
    });
}

/**
 * A signed URL is a credential, so a failure message must not print one.
 *
 * Playwright puts the compared values in the report, the report is uploaded as
 * a CI artifact, and a `public`-tier signature is good for a month. Everything
 * this pack asserts on is therefore reduced to a redacted description first.
 */
export function describeSignedUrl(raw: string): string {
  const parsed = parseSignedUrl(raw);
  if (!parsed) {
    const missing = parseMissingUrl(raw);
    if (missing) return `<missing ${missing.classroomId} ${missing.ref}>`;
    return `<not a signed url: ${raw.split('?')[0]}>`;
  }
  const bits = [`p=${parsed.tier}`, `v=${parsed.keyVersion}`, 'exp=<n>', 'sig=<redacted>'];
  if (parsed.w !== null) bits.push(`w=${parsed.w}`);
  if (parsed.fmt !== null) bits.push(`fmt=${parsed.fmt}`);
  return `${parsed.origin}/c/${parsed.classroomId}/blob/${parsed.sha}.${parsed.ext}?${bits.join('&')}`;
}

/**
 * A list of URLs, reduced to something safe to put in a failure message.
 *
 * `expect(log.delivery()).toEqual([])` reads well and, on failure, prints every
 * signed URL it saw — into a Playwright report that CI uploads as an artifact,
 * where a `public`-tier signature stays valid for a month. Comparing the
 * redacted form instead keeps the assertion and loses the credential.
 */
export function describeUrls(urls: string[]): string[] {
  return urls.map(describeSignedUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tampering — every mutation re-derives from a real URL, never a literal
// ─────────────────────────────────────────────────────────────────────────────

/** Flip the last character of `sig`, leaving a well-formed but wrong one. */
export function tamperSignature(raw: string): string {
  const url = new URL(raw);
  const sig = url.searchParams.get('sig');
  if (!sig) throw new Error('tamperSignature: url carries no sig');
  const last = sig.slice(-1);
  url.searchParams.set('sig', sig.slice(0, -1) + (last === 'A' ? 'B' : 'A'));
  return url.toString();
}

/** Append a transform the signature never covered. */
export function appendWidth(raw: string, width = 800): string {
  const url = new URL(raw);
  url.searchParams.set('w', String(width));
  return url.toString();
}

/** Push `exp` further out — the "my link never expires" forgery. */
export function extendExpiry(raw: string, seconds = 86_400): string {
  const url = new URL(raw);
  const exp = Number(url.searchParams.get('exp'));
  if (!Number.isFinite(exp)) throw new Error('extendExpiry: url carries no numeric exp');
  url.searchParams.set('exp', String(exp + seconds));
  return url.toString();
}

/** Re-point a signed URL at a different classroom, keeping everything else. */
export function swapClassroom(raw: string, classroomId: string): string {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(SIGNED_BLOB_PATH, (_full, _id, sha, ext) => {
    return `/c/${classroomId}/blob/${sha}.${ext}`;
  });
  return url.toString();
}

/** A UUID that is syntactically a classroom id and belongs to no classroom. */
export const FOREIGN_CLASSROOM_ID = '00000000-0000-4000-8000-000000000000';

// ─────────────────────────────────────────────────────────────────────────────
// Reading rendered images
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderedImage {
  src: string;
  srcset: string | null;
  sizes: string | null;
  /** What the browser actually chose — proof the candidate list is usable. */
  currentSrc: string;
  alt: string;
  signed: SignedUrl | null;
  candidates: SrcSetCandidate[];
}

/** Read one `<img>`'s delivery-relevant attributes. */
export async function readImage(locator: Locator): Promise<RenderedImage> {
  const raw = await locator.evaluate((node: HTMLImageElement) => ({
    src: node.src,
    srcset: node.getAttribute('srcset'),
    sizes: node.getAttribute('sizes'),
    currentSrc: node.currentSrc,
    alt: node.alt,
  }));
  return {
    ...raw,
    signed: parseSignedUrl(raw.src),
    candidates: parseSrcSet(raw.srcset),
  };
}

/** Read every `<img>` matching a selector, in document order. */
export async function readImages(page: Page, selector = 'img'): Promise<RenderedImage[]> {
  const images = page.locator(selector);
  const count = await images.count();
  const out: RenderedImage[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(await readImage(images.nth(index)));
  }
  return out;
}

/**
 * Reload until the page's images satisfy a predicate, or give up.
 *
 * NOT a flake workaround — a real property of the system being tested. Page and
 * deck content lives in a git repository, and GitHub's contents API is
 * eventually consistent: a read issued immediately after a write can legally
 * return the previous commit. The app itself is built around this (the slides
 * suite has its own `reloadUntil` for the same reason), so a spec that saved
 * and then asserted on one render would be asserting that GitHub is strongly
 * consistent, and would fail perhaps one run in five.
 *
 * The predicate is about the CONTENT, never a timeout: the loop ends the moment
 * the expected state is visible, and a failure after the last attempt is a real
 * failure rather than a slow success.
 */
export async function reloadUntilImages(
  page: Page,
  url: string,
  predicate: (images: RenderedImage[]) => boolean,
  { selector = 'img', attempts = 6, delayMs = 2_000 } = {}
): Promise<RenderedImage[]> {
  let images: RenderedImage[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    images = await readImages(page, selector);
    if (predicate(images)) return images;
    if (attempt < attempts - 1) await page.waitForTimeout(delayMs);
  }
  return images;
}

/**
 * A signed URL taken off a page, with no database and no session.
 *
 * This is what lets the Worker's own contract be checked against a DEPLOYED
 * environment. Everything else in the pack needs Prisma or an editor session,
 * neither of which exists against staging — but a public class site is
 * anonymous, server-rendered and already full of `public`-tier URLs, so one GET
 * yields a genuine, current signature to probe with. Minting one in the test
 * instead would mean re-implementing the canonical string and the key
 * derivation, and would then only ever prove the test agrees with itself.
 */
export async function harvestSignedFromHtml(html: string): Promise<RenderedImage | null> {
  return imagesFromHtml(html).find(image => image.signed !== null) ?? null;
}

/** The same wait, for a surface only reachable over plain HTTP. */
export async function fetchUntilHtml(
  fetcher: (url: string) => Promise<{ status: number; body: string }>,
  url: string,
  predicate: (html: string) => boolean,
  { attempts = 6, delayMs = 2_000 } = {}
): Promise<{ status: number; body: string }> {
  let last = { status: 0, body: '' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await fetcher(url);
    if (last.status === 200 && predicate(last.body)) return last;
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return last;
}

/**
 * The one `<img>` whose `src` names a given repo path's file, by sha.
 *
 * Matching by sha rather than by DOM position: a page has a title image, an
 * avatar and a logo, and "the first img" silently becomes the wrong one the
 * moment a layout changes.
 */
export function imageForSha(images: RenderedImage[], sha: string): RenderedImage | undefined {
  return images.find(image => image.signed?.sha === sha);
}

/**
 * The same three attributes, read out of SERVER-RENDERED HTML.
 *
 * The class site is script-less by design and is reached by a Host header
 * rather than a hostname a browser can resolve, so the `public` tier is only
 * observable over plain HTTP. Reading the markup is therefore not a shortcut:
 * it is the only place where what the server SENT can be separated from what a
 * client-side pass might have fixed up afterwards.
 *
 * `currentSrc` is empty here, because nothing selected a candidate — no
 * browser ran. Assertions on this shape must not use it.
 */
export function imagesFromHtml(html: string): RenderedImage[] {
  const out: RenderedImage[] = [];
  for (const [, tag] of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attr = (name: string): string | null => {
      const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
      return match ? decodeHtmlEntities(match[1]) : null;
    };
    const src = attr('src') ?? '';
    const srcset = attr('srcset');
    out.push({
      src,
      srcset,
      sizes: attr('sizes'),
      currentSrc: '',
      alt: attr('alt') ?? '',
      signed: parseSignedUrl(src),
      candidates: parseSrcSet(srcset),
    });
  }
  return out;
}

/** Only the entities an attribute value can carry. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

// ─────────────────────────────────────────────────────────────────────────────
// Counting requests
// ─────────────────────────────────────────────────────────────────────────────

export interface RequestLog {
  /** Every request to the delivery origin, in order. */
  delivery(): string[];
  /** Requests to the delivery origin for one sha (any transform). */
  forSha(sha: string): string[];
  /** `/missing/` requests — should be empty on a healthy render. */
  missing(): string[];
  /** Legacy content refs: raw.githubusercontent.com, or an app `/content/…`. */
  legacy(): string[];
  /** Everything seen, for a failure message. */
  all(): string[];
  stop(): void;
}

const LEGACY_PATTERNS = [/raw\.githubusercontent\.com/i, /\/content\/[^/]+\/[^/]+\//i];

/**
 * Watch a page's network for delivery and legacy content requests.
 *
 * Attach BEFORE the navigation that should produce them; a listener added after
 * `goto` resolves has already missed the images. Counting is the only way to
 * tell "the gate is off" from "the gate is on and every URL happens to look
 * legacy", and the only way to prove an image was fetched exactly once rather
 * than once per candidate.
 */
export function trackRequests(page: Page, origin = targets().deliveryOrigin): RequestLog {
  const host = new URL(origin).host;
  const seen: string[] = [];

  const onRequest = (request: Request) => seen.push(request.url());
  page.on('request', onRequest);

  const isDelivery = (url: string) => {
    try {
      return new URL(url).host === host;
    } catch {
      return false;
    }
  };

  return {
    all: () => [...seen],
    delivery: () => seen.filter(isDelivery),
    forSha: (sha: string) => seen.filter(url => isDelivery(url) && url.includes(sha)),
    missing: () => seen.filter(url => isDelivery(url) && parseMissingUrl(url) !== null),
    legacy: () =>
      seen.filter(url => !isDelivery(url) && LEGACY_PATTERNS.some(pattern => pattern.test(url))),
    stop: () => page.off('request', onRequest),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Image fixtures, generated rather than committed
// ─────────────────────────────────────────────────────────────────────────────

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A real, decodable RGB PNG of the requested size.
 *
 * Generated rather than committed for two reasons. A binary fixture in git is
 * unreviewable — nobody can tell a 40KB PNG from a 40KB anything — and the
 * width has to be a parameter: the pipeline's `scale-down` fit means a source
 * narrower than a rung is not upscaled, so a test about the ladder needs an
 * image wide enough for the ladder to be meaningful.
 *
 * The pixels are a deterministic gradient, not noise, so the bytes (and
 * therefore the git blob sha) are stable across runs — a re-upload of the same
 * fixture is genuinely the same blob, which is what makes the map's behaviour
 * observable rather than accidental.
 */
export function pngBytes(width = 1200, height = 60): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 255) / width;
      raw[offset + 1] = (y * 255) / height;
      raw[offset + 2] = 0x40;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // 10-12: compression, filter, interlace — all 0.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A 1x1 GIF87a.
 *
 * The point of the GIF case is the EXTENSION, not the pixels: `gif` is excluded
 * from the responsive ladder because resizing would flatten an animation to a
 * still. The smallest legal file makes that assertion without pretending the
 * test is about animation.
 */
export function gifBytes(): Buffer {
  return Buffer.from('R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=', 'base64');
}

/** A unique, prefixed name for a fixture file. */
export function fixtureName(kind: 'png' | 'gif', label: string): string {
  return `${E2E_SLUG_PREFIX}-${label}-${Date.now()}.${kind}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database access — LOCAL ONLY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `@classmoji/database` builds its PrismaClient at module scope, so every
 * import below is dynamic and happens only after DATABASE_URL is resolved.
 * A static import at the top of this file would connect to whatever
 * DATABASE_URL was set when Playwright started — on a devport, the wrong
 * database, and on a machine with none set, no database at all.
 */
async function prisma() {
  if (e2eTarget() === 'staging') {
    throw new Error('refusing to open a Prisma client while E2E_TARGET=staging');
  }
  if (!process.env.DATABASE_URL) {
    const url = devDatabaseUrl();
    if (url) process.env.DATABASE_URL = url;
  }
  // Reads are harmless, but every write path in this file reaches the database
  // through here, and the classroom this pack reads is the same one it later
  // mutates. Checking once, at the connection, is what makes the guard hard to
  // route around.
  assertWritableDatabase('open a database connection for the content-delivery e2e pack');
  const { default: getPrisma } = await import('@classmoji/database');
  return getPrisma();
}

/** The service layer, loaded the same way and for the same reason. */
export async function services() {
  await prisma();
  const { ClassmojiService } = await import('@classmoji/services');
  return ClassmojiService;
}

export interface E2EClassroom {
  id: string;
  slug: string;
  content_repo: string | null;
  content_key_version: number;
  content_delivery_enabled: boolean;
  orgLogin: string;
}

/** The classroom this run works in, read straight from the database. */
export async function classroom(slug = targets().classroomSlug): Promise<E2EClassroom> {
  const db = await prisma();
  const row = await db.classroom.findFirst({
    where: { slug },
    select: {
      id: true,
      slug: true,
      content_repo: true,
      content_key_version: true,
      content_delivery_enabled: true,
      git_organization: { select: { login: true } },
    },
  });
  if (!row) {
    throw new Error(`no classroom with slug '${slug}' — is the dev database seeded?`);
  }
  return {
    id: row.id,
    slug: row.slug,
    content_repo: row.content_repo,
    content_key_version: row.content_key_version,
    content_delivery_enabled: row.content_delivery_enabled,
    orgLogin: row.git_organization?.login ?? '',
  };
}

/**
 * Flip the per-classroom gate and hand back the previous value.
 *
 * Returning the old value rather than assuming `true` is what lets a scenario
 * restore whatever it found. A pack that always restored `true` would silently
 * switch the feature ON in the dev database of anyone who had it off.
 */
export async function setDeliveryEnabled(classroomId: string, enabled: boolean): Promise<boolean> {
  assertWritableDatabase(`set content_delivery_enabled on classroom ${classroomId}`);
  const db = await prisma();
  const before = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { content_delivery_enabled: true },
  });
  await db.classroom.update({
    where: { id: classroomId },
    data: { content_delivery_enabled: enabled },
  });
  return before.content_delivery_enabled;
}

export async function keyVersion(classroomId: string): Promise<number> {
  const db = await prisma();
  const row = await db.classroom.findUniqueOrThrow({
    where: { id: classroomId },
    select: { content_key_version: true },
  });
  return row.content_key_version;
}

/**
 * Bump the cache-bust version through the SAME service the settings action
 * calls, rather than a hand-written update.
 *
 * The assertion is about the product's behaviour — "reset content cache changes
 * every URL" — so the test has to go through the product's own increment. A
 * `{ set: n + 1 }` here would also pass while proving nothing about the
 * relative increment that makes two concurrent clicks safe.
 */
export async function bumpKeyVersion(classroomId: string): Promise<number> {
  assertWritableDatabase(`bump content_key_version on classroom ${classroomId}`);
  const service = await services();
  const { content_key_version } = await service.contentDelivery.bumpContentKeyVersion(classroomId);
  return content_key_version;
}

/** The asset map's row for one repo path, or null. */
export async function assetRow(
  classroomId: string,
  repoPath: string
): Promise<{ sha: string; type: string } | null> {
  const db = await prisma();
  const row = await db.contentAsset.findFirst({
    where: { classroom_id: classroomId, path: repoPath },
    select: { sha: true, type: true },
  });
  return row;
}

/**
 * Re-read the repo tree into the asset map, the way the app does.
 *
 * The push webhook normally keeps the map current; a test that changes the repo
 * behind the app's back has to trigger the same sync explicitly, or it is
 * asserting against a map that simply has not heard the news yet — a flake that
 * looks exactly like the bug it is meant to catch.
 */
export async function syncMap(classroomId: string): Promise<void> {
  assertWritableDatabase(`re-sync the asset map for classroom ${classroomId}`);
  const service = await services();
  await service.contentAssets.syncContentAssets(classroomId, { full: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Content repo access — never a hardcoded token
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a file out of the classroom's content repo, through the app's own
 * ContentService.
 *
 * ContentService resolves the org's GitHub App installation from the database
 * and mints an installation token per call — the same credential path the
 * product uses. No token is ever read from a literal here, and none should be:
 * a token in a spec is a token in the git history.
 */
export async function readRepoFile(
  target: E2EClassroom,
  repoPath: string
): Promise<{ content: string; sha: string } | null> {
  const { ContentService } = await import('@classmoji/services');
  if (!target.content_repo) throw new Error(`classroom ${target.slug} has no content_repo`);
  return ContentService.getContent({
    orgLogin: target.orgLogin,
    repo: target.content_repo,
    path: repoPath,
    skipCache: true,
  });
}

/** Delete a file from the content repo — used to manufacture a dangling ref. */
export async function deleteRepoFile(target: E2EClassroom, repoPath: string): Promise<void> {
  // A repo write does not go through Prisma, so it would not be covered by the
  // connection guard. The database is still the right thing to check: it is
  // what told us WHICH repo to write to, so a production database means a
  // production repo even though the write itself is a GitHub call.
  assertWritableDatabase(`delete ${repoPath} from ${target.content_repo}`);
  const { ContentService } = await import('@classmoji/services');
  if (!target.content_repo) throw new Error(`classroom ${target.slug} has no content_repo`);
  await ContentService.delete({
    orgLogin: target.orgLogin,
    repo: target.content_repo,
    path: repoPath,
    message: `${E2E_PREFIX}: remove test asset ${repoPath}`,
  });
}

/**
 * A page's stored `content.json`, parsed.
 *
 * The whole storage contract — no signature, no srcset, no delivery origin, a
 * bare repo-relative path — is a claim about THIS file, so it has to be read
 * from the repo rather than inferred from what the editor showed.
 */
export async function readStoredContent(
  target: E2EClassroom,
  contentPath: string
): Promise<{ raw: string; json: unknown }> {
  const file = await readRepoFile(target, `${contentPath.replace(/\/+$/, '')}/content.json`);
  if (!file) throw new Error(`no content.json at ${contentPath} in ${target.content_repo}`);
  return { raw: file.content, json: JSON.parse(file.content) };
}

/**
 * A page row with the classroom and git organization a content write needs.
 *
 * `contentRepoFor` in the page-content service refuses anything less, and the
 * refusal is a thrown Error rather than a typed one — so the include list is
 * part of the contract, not an optimization.
 */
export async function pageWithRepo(pageId: string) {
  const service = await services();
  const page = await service.page.findById(pageId, { includeClassroom: true });
  // `findById` is nullable, and every caller here immediately hands the result
  // to a content-repo write that dereferences `classroom.git_organization`.
  // Throwing names the missing page; passing null through produced a
  // `Cannot read properties of null` from three frames deeper.
  if (!page) throw new Error(`no page with id '${pageId}'`);
  return page;
}

/** A page's blocks, through the product's own reader. */
export async function loadPageBlocks(pageId: string): Promise<unknown[]> {
  const service = await services();
  const page = await pageWithRepo(pageId);
  const content = await service.pageContent.loadPageContent(page, { skipCache: true });
  return Array.isArray(content?.blocks) ? content.blocks : [];
}

/**
 * Write a page's blocks through the product's own save path.
 *
 * Through `savePageContent` rather than a hand-rolled `ContentService.put`,
 * because the save path is where `canonicalizeAssetRef` runs — the pass that
 * keeps a rendered signature from being written back into storage. A fixture
 * that bypassed it would set up the very state the storage assertions are
 * meant to prove impossible.
 */
export async function savePageBlocks(pageId: string, blocks: unknown[]): Promise<void> {
  assertWritableDatabase(`write page content for ${pageId}`);
  const service = await services();
  const page = await pageWithRepo(pageId);
  await service.pageContent.savePageContent(page, blocks, {
    message: `${E2E_PREFIX}: fixture write`,
  });
}

/** The BlockNote image block the editor itself would have inserted. */
export function imageBlock(repoPath: string, caption: string): Record<string, unknown> {
  return {
    id: `${E2E_SLUG_PREFIX}-${Math.random().toString(36).slice(2, 10)}`,
    type: 'image',
    props: {
      // The STORED value: a bare repo path. The signed URL is derived from it
      // at render time and never written back.
      url: repoPath,
      caption,
      previewWidth: FIXTURE_PREVIEW_WIDTH,
      backgroundColor: 'default',
      textAlignment: 'left',
      name: '',
    },
    content: undefined,
    children: [],
  };
}

/** Does any block still reference this repo path, anywhere in its props? */
export function blocksReference(blocks: unknown[], repoPath: string): boolean {
  return JSON.stringify(blocks).includes(repoPath);
}

/**
 * The three things that must never appear in stored content.
 *
 * Asserted on the RAW text, not the parsed object: a signature could be hiding
 * in a nested prop, an HTML string, or a key nobody thought to walk, and the
 * point of the invariant is that it holds everywhere rather than in the places
 * a traversal remembered to look.
 */
export function storedContentLeaks(raw: string, deliveryOrigin: string): string[] {
  const leaks: string[] = [];
  if (raw.includes('sig=')) leaks.push('sig=');
  if (/srcset/i.test(raw)) leaks.push('srcset');
  if (raw.includes(new URL(deliveryOrigin).host)) leaks.push(new URL(deliveryOrigin).host);
  return leaks;
}
