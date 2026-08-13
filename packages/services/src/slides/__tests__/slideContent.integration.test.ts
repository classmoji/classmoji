/**
 * Live-GitHub integration suite for saveDeck/loadDeck (content-tools plan §9,
 * "Live-GitHub integration suite" — the saveDeck end-to-end group).
 *
 * GATED — skipped unless CONTENT_INT_TEST is set, so normal CI never runs it:
 *
 *   CONTENT_INT_TEST=1 npx vitest run src/slides/__tests__/slideContent.integration.test.ts
 *
 * Runs against the REAL GitHub API using the dev database's GitOrganization
 * and its per-classroom content repo. The "slide" is a fake in-memory target
 * (real classroom + git_organization, `id` undefined) whose content_path
 * lives under a unique throwaway prefix `__int_test__/<ts>-<rand>-slides/…` —
 * saveDeck's `if (slide.id && !isPreviewBranch)` guard means no DB row is
 * touched. afterAll deletes the prefix and asserts it is gone. Real content
 * paths (pages/, slides/, .slidesthemes/, .classmoji/) are never touched.
 *
 * Covers:
 *   - first save: deck.json + index.html land in ONE commit; returned deck
 *     sha ≡ getMeta; returned html byte-equals the committed artifact
 *   - live round-trip: parseDeckHtml(committed index.html) recovers the deck
 *   - §3 conflict table, 'deck' rows: matching sha proceeds, stale sha → 409
 *     (DeckConflictError) with no clobber
 *   - §3 conflict table, 'legacy_html' rows: sha differs → 409; sha matches →
 *     proceed (materializes deck.json); deck.json-materialized-in-between
 *     crossover → 409
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load the repo root .env BEFORE any service module evaluates —
// GitHubProvider computes the App private key at module load, so every
// service import below is deferred into beforeAll via dynamic import.
dotenv.config({ path: fileURLToPath(new URL('../../../../../.env', import.meta.url)) });

const RUN = Boolean(process.env.CONTENT_INT_TEST);

/** Structural twin of the services' (unexported) git org record. */
interface GitOrgRecord {
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

const TEST_TIMEOUT = 120_000;
const PREFIX = `__int_test__/${Date.now()}-${randomBytes(3).toString('hex')}-slides`;

describe.skipIf(!RUN)('saveDeck live-GitHub integration', () => {
  let ContentService: typeof import('../../content/ContentService.ts').ContentService;
  let slideContent: typeof import('../slideContent.service.ts');
  let deckHtml: typeof import('../deckHtml.ts');
  let getGitProvider: typeof import('../../git/index.ts').getGitProvider;
  let prisma: { $disconnect: () => Promise<void> } | null = null;

  let gitOrganization: GitOrgRecord;
  let repo: string;

  type DeckJson = import('../deckTypes.ts').DeckJson;

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  /**
   * Poll an async check until it stops throwing. GitHub's Contents API is
   * eventually consistent on read-after-write (observed live: a GET right
   * after a successful commit intermittently 404s or serves the previous sha
   * for ~1-2s) — read-side assertions that follow a write must poll.
   */
  async function eventually<T>(
    check: () => Promise<T>,
    label: string,
    timeoutMs = 30_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (;;) {
      try {
        return await check();
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) {
          throw new Error(
            `eventually(${label}) timed out after ${timeoutMs}ms — last: ${String(lastError)}`
          );
        }
        await sleep(750);
      }
    }
  }

  /** Fake slide target: real classroom/org context, no DB row (id undefined). */
  function slideTarget(contentPath: string, title: string) {
    return {
      // id intentionally undefined: saveDeck's updated_at bump is guarded by
      // `if (slide.id && !isPreviewBranch)`, so no database write happens.
      title,
      content_path: contentPath,
      classroom: {
        content_repo: repo,
        git_organization: gitOrganization,
      },
    };
  }

  function makeDeck(overrides: Partial<DeckJson> = {}): DeckJson {
    return {
      version: 1,
      theme: 'white',
      codeTheme: 'github',
      config: { center: false },
      customCss: '.reveal h1 { letter-spacing: 0.01em; }',
      slides: [
        { id: 'int00001', html: '<h1>Integration</h1><p>hello</p>', notes: 'opening notes' },
        { id: 'int00002', html: '<h2>Second</h2>', hidden: true },
        {
          id: 'int00003',
          attrs: { 'data-background-color': '#123456' },
          html: '<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>',
        },
      ],
      ...overrides,
    };
  }

  beforeAll(async () => {
    ({ ContentService } = await import('../../content/ContentService.ts'));
    slideContent = await import('../slideContent.service.ts');
    deckHtml = await import('../deckHtml.ts');
    ({ getGitProvider } = await import('../../git/index.ts'));
    const getPrisma = (await import('@classmoji/database')).default;
    const db = getPrisma();
    prisma = db as unknown as { $disconnect: () => Promise<void> };

    const orgLogin = process.env.CONTENT_INT_ORG || 'classmoji-development';
    const classroom = await db.classroom.findFirst({
      where: {
        is_example: false,
        git_organization: {
          provider: 'GITHUB',
          login: orgLogin,
          github_installation_id: { not: null },
        },
      },
      include: { git_organization: true },
      orderBy: { created_at: 'desc' },
    });
    if (!classroom?.git_organization) {
      throw new Error(
        `No classroom with an installed GitHub App found for org '${orgLogin}' — ` +
          'is the dev database seeded and running?'
      );
    }
    gitOrganization = classroom.git_organization;
    // Stored on the classroom row and user-editable — never re-derived.
    repo = classroom.content_repo;

    const probe = await ContentService.compareBranches({
      gitOrganization,
      repo,
      base: 'main',
      head: 'main',
    });
    if (!probe) {
      throw new Error(`Content repo ${gitOrganization.login}/${repo} not found on GitHub`);
    }
    console.log(`[int-test] Using ${gitOrganization.login}/${repo}, prefix ${PREFIX}`);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!ContentService || !gitOrganization) {
      // beforeAll failed before any writes could happen — nothing to clean.
      await prisma?.$disconnect();
      return;
    }
    // Delete the throwaway prefix from main, then ASSERT it is gone (plan
    // gate). deleteFolder lists through the same eventually-consistent
    // Contents API it deletes with: its listing can miss just-written files
    // or include ghosts of just-deleted ones (ghost paths → 422
    // GitRPC::BadObjectState from its Trees call — observed live, and it
    // aborted a whole cleanup pass). Loop: attempt delete (failure
    // tolerated), settle, verify with two consecutive empty listings.
    let cleanupError: string | null = null;
    try {
      const deadline = Date.now() + 120_000;
      let lastError: unknown = null;
      for (;;) {
        try {
          await ContentService.deleteFolder({
            gitOrganization,
            repo,
            path: PREFIX,
            message: `[int-test] clean up ${PREFIX}`,
          });
        } catch (error) {
          lastError = error; // the empty-listing check below decides
        }
        await sleep(2000);
        const leftover = await ContentService.listFolder({
          gitOrganization,
          repo,
          path: PREFIX,
          skipCache: true,
        });
        if (leftover.length === 0) {
          await sleep(2000); // don't trust a single (possibly ghost-empty) listing
          const confirm = await ContentService.listFolder({
            gitOrganization,
            repo,
            path: PREFIX,
            skipCache: true,
          });
          if (confirm.length === 0) break;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `prefix ${PREFIX} not fully removed (${leftover.length} entries remain); ` +
              `last deleteFolder error: ${String(lastError)}`
          );
        }
      }
    } catch (error: unknown) {
      cleanupError = String(error);
      console.error(`[int-test] CLEANUP FAILURE — manual sweep needed for ${PREFIX}:`, error);
    }

    await prisma?.$disconnect();
    expect(cleanupError, `cleanup failed: ${cleanupError}`).toBeNull();
  }, 300_000);

  // Shared across the sequential tests below (vitest runs tests in a file in
  // declaration order).
  const deckPath = () => `${PREFIX}/deck-e2e/deck.json`;
  const htmlPath = () => `${PREFIX}/deck-e2e/index.html`;
  let firstSaveSha: string;
  let secondSaveSha: string;

  it(
    'first save lands deck.json + index.html in ONE commit; shas and html match the committed files',
    async () => {
      const slide = slideTarget(`${PREFIX}/deck-e2e`, 'Integration Test Deck');
      const deck = makeDeck();

      const result = await slideContent.saveDeck({
        slide,
        deck,
        message: '[int-test] first save (materialize)',
      });
      firstSaveSha = result.sha;
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

      // ONE commit containing BOTH files — verified against the real commit.
      const octokit = await getGitProvider(gitOrganization).getOctokit();
      const { data: commitData } = await octokit.request(
        'GET /repos/{owner}/{repo}/commits/{ref}',
        { owner: gitOrganization.login, repo, ref: result.commit }
      );
      const touched = (commitData.files ?? []).map((f: { filename: string }) => f.filename);
      expect(touched).toEqual(expect.arrayContaining([deckPath(), htmlPath()]));
      expect(commitData.parents).toHaveLength(1);

      // deck.json round-trips byte-for-byte (pretty JSON + trailing newline)
      // and its sha matches what saveDeck returned. Polled — Contents reads
      // right after a Trees-API commit hit read-after-write lag.
      const deckFile = await eventually(async () => {
        const read = await ContentService.getContent({
          gitOrganization,
          repo,
          path: deckPath(),
          skipCache: true,
        });
        if (read?.sha !== result.sha) throw new Error(`deck.json sha ${read?.sha} != ${result.sha}`);
        return read;
      }, 'deck.json visible');
      expect(deckFile.content).toBe(JSON.stringify(deck, null, 2) + '\n');
      expect(JSON.parse(deckFile.content)).toEqual(deck);

      // index.html is the returned html, byte-identical (the editor's
      // savedContent CDN-lag workaround depends on this equivalence).
      const htmlFile = await eventually(async () => {
        const read = await ContentService.getContent({
          gitOrganization,
          repo,
          path: htmlPath(),
          skipCache: true,
        });
        if (read?.content !== result.html) throw new Error('index.html not visible yet');
        return read;
      }, 'index.html visible');
      expect(htmlFile.content).toContain('data-cm-id="int00001"');
      expect(htmlFile.content).toContain('<aside class="notes">opening notes</aside>');
      expect(htmlFile.content).toContain('data-hidden="true"');
      expect(htmlFile.content).toContain('data-background-color="#123456"');
    },
    TEST_TIMEOUT
  );

  it(
    'the committed index.html parses back to the same deck (live round-trip)',
    async () => {
      const htmlFile = await ContentService.getContent({
        gitOrganization,
        repo,
        path: htmlPath(),
        skipCache: true,
      });
      const { deck: parsed, warnings } = deckHtml.parseDeckHtml(htmlFile!.content);
      expect(warnings).toEqual([]);
      expect(parsed.slides.map(s => s.id)).toEqual(['int00001', 'int00002', 'int00003']);
      expect(parsed.slides[0].notes).toBe('opening notes');
      expect(parsed.slides[1].hidden).toBe(true);
      expect(parsed.slides[2].attrs).toEqual({ 'data-background-color': '#123456' });
      expect(parsed.theme).toBe('white');
      expect(parsed.codeTheme).toBe('github');
      expect(parsed.config).toEqual({ center: false });
      expect(parsed.customCss).toBe('.reveal h1 { letter-spacing: 0.01em; }');
    },
    TEST_TIMEOUT
  );

  it(
    "conflict table 'deck' rows: matching expectedSha proceeds; stale sha → 409, no clobber",
    async () => {
      const slide = slideTarget(`${PREFIX}/deck-e2e`, 'Integration Test Deck');

      // Matching sha → proceed.
      const editedDeck = makeDeck({
        slides: [
          { id: 'int00001', html: '<h1>Integration</h1><p>edited</p>', notes: 'opening notes' },
          { id: 'int00002', html: '<h2>Second</h2>', hidden: true },
          {
            id: 'int00003',
            attrs: { 'data-background-color': '#123456' },
            html: '<pre><code class="language-js">const x = 1 &lt; 2;</code></pre>',
          },
        ],
      });
      const second = await slideContent.saveDeck({
        slide,
        deck: editedDeck,
        expectedSha: firstSaveSha,
        shaSource: 'deck',
        message: '[int-test] second save (sha matches)',
      });
      secondSaveSha = second.sha;
      expect(second.sha).not.toBe(firstSaveSha);

      // Sync until the second save is what reads serve, so the stale save
      // below fails its precheck deterministically.
      await eventually(async () => {
        const meta = await ContentService.getMeta({
          gitOrganization,
          repo,
          path: deckPath(),
          skipCache: true,
        });
        if (meta?.sha !== secondSaveSha) {
          throw new Error(`deck.json sha ${meta?.sha} != ${secondSaveSha} yet`);
        }
      }, 'second save visible');

      // Stale sha (the first save's) → DeckConflictError with 409 semantics.
      const clobberDeck = makeDeck({
        slides: [{ id: 'int00001', html: '<h1>stale clobber</h1>' }],
      });
      await expect(
        slideContent.saveDeck({
          slide,
          deck: clobberDeck,
          expectedSha: firstSaveSha,
          shaSource: 'deck',
          message: '[int-test] stale save (must 409)',
        })
      ).rejects.toMatchObject({
        name: 'DeckConflictError',
        status: 409,
        code: 'CONTENT_CONFLICT',
      });

      // No clobber: deck.json still holds the second save.
      const after = await ContentService.getContent({
        gitOrganization,
        repo,
        path: deckPath(),
        skipCache: true,
      });
      expect(after?.sha).toBe(secondSaveSha);
      expect(JSON.parse(after!.content)).toEqual(editedDeck);
    },
    TEST_TIMEOUT
  );

  it(
    "conflict table 'legacy_html' rows: wrong sha → 409; matching sha materializes; crossover → 409",
    async () => {
      // Seed a LEGACY deck: index.html only, no deck.json.
      const legacyPath = `${PREFIX}/legacy-deck`;
      const slide = slideTarget(legacyPath, 'Legacy Integration Deck');
      const legacyDeck = makeDeck({
        customCss: undefined,
        config: undefined,
        slides: [
          { id: 'leg00001', html: '<h1>Legacy</h1>', notes: 'legacy notes' },
          { id: 'leg00002', html: '<h2>Still legacy</h2>' },
        ],
      });
      const legacyHtml = deckHtml.generateDeckHtml(legacyDeck, {
        title: 'Legacy Integration Deck',
        includeNotes: true,
      });
      await ContentService.put({
        gitOrganization,
        repo,
        path: `${legacyPath}/index.html`,
        content: legacyHtml,
        message: '[int-test] seed legacy index.html',
      });

      // loadDeck falls back to parsing index.html (polled — the seed write
      // may not be visible to reads yet).
      const loaded = await eventually(
        () => slideContent.loadDeck(slide, { skipCache: true }),
        'legacy index.html loadable'
      );
      expect(loaded.sha_source).toBe('legacy_html');
      expect(loaded.deck.slides.map(s => s.id)).toEqual(['leg00001', 'leg00002']);

      // Pin the read state before exercising the conflict rows: the html sha
      // loadDeck returned must be what the save prechecks will see.
      await eventually(async () => {
        const meta = await ContentService.getMeta({
          gitOrganization,
          repo,
          path: `${legacyPath}/index.html`,
          skipCache: true,
        });
        if (meta?.sha !== loaded.sha) throw new Error(`html sha ${meta?.sha} != ${loaded.sha}`);
      }, 'legacy html sha stable');

      // Row: legacy_html + still absent + sha differs → 409.
      await expect(
        slideContent.saveDeck({
          slide,
          deck: loaded.deck,
          expectedSha: '0'.repeat(40),
          shaSource: 'legacy_html',
          message: '[int-test] legacy save with wrong sha (must 409)',
        })
      ).rejects.toMatchObject({ name: 'DeckConflictError', status: 409 });
      expect(
        await ContentService.getMeta({
          gitOrganization,
          repo,
          path: `${legacyPath}/deck.json`,
          skipCache: true,
        })
      ).toBeNull(); // still not materialized

      // Row: legacy_html + still absent + sha matches → proceed (materialize).
      const materialized = await slideContent.saveDeck({
        slide,
        deck: loaded.deck,
        expectedSha: loaded.sha,
        shaSource: 'legacy_html',
        message: '[int-test] legacy save materializes deck.json',
      });
      await eventually(async () => {
        const deckMeta = await ContentService.getMeta({
          gitOrganization,
          repo,
          path: `${legacyPath}/deck.json`,
          skipCache: true,
        });
        if (deckMeta?.sha !== materialized.sha) {
          throw new Error(`deck.json sha ${deckMeta?.sha} != ${materialized.sha} yet`);
        }
      }, 'materialized deck.json visible');

      // Crossover row: a writer still holding a legacy_html sha (even the
      // CURRENT index.html sha) must 409 now that deck.json exists.
      const currentHtml = await eventually(async () => {
        const meta = await ContentService.getMeta({
          gitOrganization,
          repo,
          path: `${legacyPath}/index.html`,
          skipCache: true,
        });
        if (!meta) throw new Error('regenerated index.html not visible yet');
        return meta;
      }, 'regenerated index.html visible');
      await expect(
        slideContent.saveDeck({
          slide,
          deck: loaded.deck,
          expectedSha: currentHtml.sha,
          shaSource: 'legacy_html',
          message: '[int-test] legacy crossover save (must 409)',
        })
      ).rejects.toMatchObject({
        name: 'DeckConflictError',
        status: 409,
        code: 'CONTENT_CONFLICT',
      });
    },
    TEST_TIMEOUT
  );
});
