/**
 * html and svg slide blocks in the live deck, as people see them: an agent
 * adds both to a slide (block_add through the MCP's own collab client,
 * acting as TEACHER_2), two people in the live editor see them converge, and
 * the html block's code runs in its sandbox: it cannot reach the page around
 * it (`parent.document`, `top.location`) nor its cookies, while its
 * in-memory `localStorage` works. The same holds in the presenter. The
 * scratch slide is deleted at the end.
 *
 * Opt-in like live-editing.spec.ts:
 *
 *   COLLAB_E2E=1 npx dotenv -e .env -- ./scripts/devport.sh run \
 *     npx playwright test -c tests/collab slide-blocks
 *
 * With DEVPORT_PUBLIC_HOST set, sign in on that host: add
 * `env WEBAPP_URL=http://<host>:3010 SLIDES_URL=http://<host>:6510` after `run`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CollabActor } from '@classmoji/collab';

import {
  CLASSROOM_ID,
  COLLAB_USERS,
  KITCHEN_SINK_DECK_TITLE,
} from '../../scripts/collab-dev/constants.ts';
import { SLIDES_URL, db, signIn } from './helpers.ts';

const [TEACHER_1, TEACHER_2] = COLLAB_USERS;
const RUN = Date.now().toString(36);
const SKIP_REASON = 'Set COLLAB_E2E=1 with the dev stack running';

type CollabClient = typeof import('../../apps/mcp/src/collab/client.ts');
type CollabEnv = NonNullable<ReturnType<typeof import('@classmoji/collab/env').resolveCollabEnv>>;

/** The html block's code: tries to leave its frame, then reports to whoever hosts it. */
const PROBE_SOURCE = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="120"></canvas><script>
var r = { run: '${RUN}' };
function t(name, fn) { try { r[name] = 'ok:' + String(fn()); } catch (e) { r[name] = 'blocked:' + e.name; } }
t('parentDocument', function () { return !!parent.document; });
t('topLocation', function () { return top.location.href; });
t('cookie', function () { return document.cookie; });
t('storage', function () { localStorage.setItem('k', 'v'); return localStorage.getItem('k'); });
var ctx = document.getElementById('c').getContext('2d');
var x = 0;
(function draw() { ctx.fillStyle = '#0b7'; ctx.clearRect(0, 0, 200, 120); ctx.fillRect(x % 180, 40, 20, 20); x += 2; requestAnimationFrame(draw); })();
parent.postMessage({ cmBlockProbe: r }, '*');
</script></body></html>`;

const SVG_SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<circle cx="50" cy="50" r="40" fill="currentColor"/><script>alert(1)</script></svg>';

type Probe = Record<string, string>;

/** Collect probe messages posted by html blocks to this page. */
async function listenForProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cmProbes: unknown[] };
    w.__cmProbes = [];
    window.addEventListener('message', event => {
      const data = event.data as { cmBlockProbe?: unknown } | null;
      if (data && typeof data === 'object' && data.cmBlockProbe)
        w.__cmProbes.push(data.cmBlockProbe);
    });
  });
}

async function probeOf(page: Page): Promise<Probe | null> {
  return page.evaluate(run => {
    const probes = (window as unknown as { __cmProbes?: Array<Record<string, string>> }).__cmProbes;
    return probes?.filter(p => p.run === run).at(-1) ?? null;
  }, RUN);
}

function expectContained(probe: Probe | null): void {
  expect(probe).not.toBeNull();
  expect(probe?.parentDocument).toBe('blocked:SecurityError');
  expect(probe?.topLocation).toBe('blocked:SecurityError');
  expect(probe?.cookie).toBe('blocked:SecurityError');
  expect(probe?.storage).toBe('ok:v');
}

async function openLive(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    if (attempt === 1) await page.goto(url, { waitUntil: 'domcontentloaded' });
    else await page.reload({ waitUntil: 'domcontentloaded' });
    try {
      await expect(page.getByTestId('live-sync-status').first()).toHaveAttribute(
        'data-status',
        'synced',
        { timeout: 40_000 }
      );
      await page
        .locator('.reveal.ready .slides section.present[contenteditable]')
        .first()
        .waitFor({ timeout: 40_000 });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}

/** Step the editor right until the slide with this id is the one shown. */
async function showSlide(page: Page, slideId: string): Promise<void> {
  const current = page.locator(`.reveal .slides section.present[data-cm-id="${slideId}"]`);
  for (let i = 0; i < 60 && (await current.count()) === 0; i++) {
    await page.locator('.reveal .controls .navigate-right').click();
    await page.waitForTimeout(150);
  }
  await expect(current).toHaveCount(1);
}

test.describe('svg and html slide blocks', () => {
  test.skip(!process.env.COLLAB_E2E, SKIP_REASON);
  test.describe.configure({ mode: 'serial' });

  let deckId = '';
  let client: CollabClient;
  let env: CollabEnv;
  let agent: CollabActor;

  test.beforeAll(async () => {
    const prisma = await db();
    const deck = await prisma.slide.findFirstOrThrow({
      where: { classroom_id: CLASSROOM_ID, title: KITCHEN_SINK_DECK_TITLE },
    });
    const teacher2 = await prisma.user.findFirstOrThrow({ where: { email: TEACHER_2.email } });
    deckId = deck.id;
    client = await import('../../apps/mcp/src/collab/client.ts');
    const { resolveCollabEnv } = await import('@classmoji/collab/env');
    const resolved = resolveCollabEnv();
    expect(resolved, 'COLLAB_URL / COLLAB_INTERNAL_SECRET (run through devport.sh)').toBeTruthy();
    env = resolved!;
    agent = {
      userId: teacher2.id,
      name: teacher2.name ?? TEACHER_2.name,
      agentSession: `blocks-${RUN}`,
    };
  });

  async function person(browser: Browser, login: string): Promise<BrowserContext> {
    const context = await browser.newContext();
    await signIn(context, login);
    return context;
  }

  test('an agent adds both blocks; two editors converge; the html block stays in its sandbox', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const inserted = await client.postOps(
      env,
      'deck',
      deckId,
      [{ op: 'insert', slides: [{ html: `<h2>Blocks ${RUN}</h2>` }], position: { at: 'end' } }],
      agent
    );
    const slideId = (inserted.insertedIds as string[] | undefined)?.[0];
    expect(slideId, 'inserted slide id').toBeTruthy();

    const contexts: BrowserContext[] = [];
    try {
      const snapshot = await client.fetchSnapshot(env, 'deck', deckId);
      const index = snapshot.content.slides.findIndex(s => s.id === slideId);
      expect(index).toBeGreaterThan(-1);

      const pages: Page[] = [];
      for (const login of [TEACHER_1.login, TEACHER_2.login]) {
        const context = await person(browser, login);
        contexts.push(context);
        const page = await context.newPage();
        await listenForProbes(page);
        await openLive(page, `${SLIDES_URL}/${deckId}?mode=edit#/${index}`);
        await showSlide(page, slideId as string);
        pages.push(page);
      }

      await client.postOps(
        env,
        'deck',
        deckId,
        [
          {
            op: 'block_add',
            slide: slideId as string,
            type: 'html',
            box: { left: 60, top: 160, width: 400, height: 260 },
            source: PROBE_SOURCE,
          },
          {
            op: 'block_add',
            slide: slideId as string,
            type: 'svg',
            box: { left: 520, top: 160, width: 260, height: 260 },
            source: SVG_SOURCE,
          },
        ],
        agent
      );

      for (const page of pages) {
        const section = page.locator(`section[data-cm-id="${slideId}"]`);
        const frame = section.locator('.sl-block[data-block-type="html"] iframe');
        await expect(frame).toHaveAttribute(
          'sandbox',
          'allow-scripts allow-pointer-lock allow-modals allow-popups'
        );
        await expect(frame).toHaveAttribute('srcdoc', /cmBlockProbe/);
        const svg = section.locator('.sl-block[data-block-type="svg"] svg');
        await expect(svg).toHaveCount(1);
        await expect(svg.locator('circle')).toHaveCount(1);
        await expect(svg.locator('script')).toHaveCount(0);
        await expect.poll(() => probeOf(page), { timeout: 15_000 }).not.toBeNull();
        expectContained(await probeOf(page));
      }

      // The presenter (which reads the saved deck, once the live deck has been
      // written back) shows the same block, just as contained.
      const viewer = await contexts[0].newPage();
      await listenForProbes(viewer);
      await expect
        .poll(
          async () => {
            await viewer.goto(`${SLIDES_URL}/${deckId}/present`, { waitUntil: 'domcontentloaded' });
            await viewer.locator('.reveal .slides section').first().waitFor({ timeout: 30_000 });
            const at = await viewer.evaluate(
              id =>
                Array.from(document.querySelectorAll('.reveal .slides > section')).findIndex(
                  s => s.getAttribute('data-cm-id') === id
                ),
              slideId as string
            );
            if (at < 0) return null;
            await viewer.evaluate(at => (window.location.hash = `#/${at}`), at);
            await expect.poll(() => probeOf(viewer), { timeout: 15_000 }).not.toBeNull();
            return probeOf(viewer);
          },
          { timeout: 150_000, intervals: [5_000] }
        )
        .not.toBeNull();
      expectContained(await probeOf(viewer));
    } finally {
      for (const context of contexts) await context.close();
      if (slideId) {
        await client.postOps(env, 'deck', deckId, [{ op: 'delete', id: slideId }], agent);
      }
    }
  });
});
