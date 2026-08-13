/**
 * Live-GitHub integration suite for ContentService (content-tools plan §9,
 * "Live-GitHub integration suite").
 *
 * GATED — skipped unless CONTENT_INT_TEST is set, so normal CI never runs it:
 *
 *   CONTENT_INT_TEST=1 npx vitest run src/content/__tests__/ContentService.integration.test.ts
 *
 * Runs against the REAL GitHub API using the dev database's GitOrganization
 * (GitHub App installation) and its per-classroom content repo. All writes
 * land under a unique throwaway prefix `__int_test__/<ts>-<rand>-content/…`
 * on main, plus throwaway `preview/__int_test__/…` branches. afterAll deletes
 * the prefix and every branch created and ASSERTS both are gone. Real content
 * paths (pages/, slides/, .slidesthemes/, .classmoji/) are never touched.
 *
 * Env overrides:
 *   CONTENT_INT_ORG — GitOrganization login to use (default classmoji-development)
 *
 * Covers (plan §9 E2E layers):
 *   1. put + expectedSha CAS (stale sha → 409, no clobber)
 *   2. ref/branch plumbing: createBranch from main HEAD (compareBranches
 *      self-compare trick), branch put, ref reads, main-cache isolation
 *   3. mergeBranch: disjoint two-file merge, disjoint same-file regions of
 *      pretty-printed JSON, same-region conflict (branch survives), cleanup
 *   4. uploadBatch + verifyBaseTree: happy path (blob sha ≡ getMeta sha) and
 *      the forced-race CAS (concurrent put before the batch → verifier error,
 *      concurrent write survives)
 *   6. compareBranches ahead/behind/merge-base sanity
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

/** Structural twin of ContentService's (unexported) git org record. */
interface GitOrgRecord {
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

const TEST_TIMEOUT = 120_000;
const PREFIX = `__int_test__/${Date.now()}-${randomBytes(3).toString('hex')}-content`;

describe.skipIf(!RUN)('ContentService live-GitHub integration', () => {
  let ContentService: typeof import('../ContentService.ts').ContentService;
  let prisma: { $disconnect: () => Promise<void> } | null = null;

  let gitOrganization: GitOrgRecord;
  let repo: string;

  /** Every branch this run creates — afterAll deletes and asserts gone. */
  const createdBranches: string[] = [];

  const pretty = (doc: unknown) => JSON.stringify(doc, null, 2) + '\n';

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  /**
   * Poll an async check until it stops throwing. The live suite's first run
   * proved GitHub's Contents API is eventually consistent on read-after-write:
   * a GET immediately after a successful write intermittently 404s or serves
   * the previous sha for ~1-2s (observed against api.github.com, 2026-08-02).
   * Read-side assertions that follow a write must poll, not read once.
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

  /**
   * put(), retried when GitHub's write path validates against a lagging
   * replica. Observed live: a PUT carrying the sha a fresh GET just returned
   * can still 422 ("<path> does not match <sha>") when it lands within ~1s of
   * the previous write to the same path. Only 422s are retried — real
   * conflicts (our 409) always propagate.
   */
  async function lagTolerantPut(
    args: Parameters<typeof ContentService.put>[0],
    attempts = 6
  ): Promise<{ sha: string; commit: string }> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await ContentService.put(args);
      } catch (error) {
        const status = (error as { status?: number }).status;
        const msg = String((error as { message?: string }).message ?? '');
        const lagShaped = status === 422 && /does not match|sha/i.test(msg);
        if (!lagShaped) throw error;
        lastError = error;
        await sleep(1000);
      }
    }
    throw lastError;
  }

  /**
   * Remove the throwaway prefix from main, tolerating Contents-API lag.
   * deleteFolder lists through the same eventually-consistent API it deletes
   * with: right after recent commits its listing can miss just-written files
   * or include ghosts of just-deleted ones — ghost paths make its Trees call
   * 422 (GitRPC::BadObjectState, path absent from the base tree; observed
   * live). Loop: attempt delete (failure tolerated), let the listing settle,
   * re-check, until two consecutive listings are empty or the deadline hits.
   */
  async function removePrefix(prefix: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    for (;;) {
      try {
        await ContentService.deleteFolder({
          gitOrganization,
          repo,
          path: prefix,
          message: `[int-test] clean up ${prefix}`,
        });
      } catch (error) {
        lastError = error; // the empty-listing check below decides
      }
      await sleep(2000);
      const leftover = await ContentService.listFolder({
        gitOrganization,
        repo,
        path: prefix,
        skipCache: true,
      });
      if (leftover.length === 0) {
        await sleep(2000); // don't trust a single (possibly ghost-empty) listing
        const confirm = await ContentService.listFolder({
          gitOrganization,
          repo,
          path: prefix,
          skipCache: true,
        });
        if (confirm.length === 0) return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `prefix ${prefix} not fully removed (${leftover.length} entries remain); ` +
            `last deleteFolder error: ${String(lastError)}`
        );
      }
    }
  }

  /** Main's current HEAD sha via the compareBranches self-compare trick. */
  async function mainHeadSha(): Promise<string> {
    const self = await ContentService.compareBranches({
      gitOrganization,
      repo,
      base: 'main',
      head: 'main',
    });
    if (!self) throw new Error('main...main compare returned null — repo has no main branch?');
    return self.base_sha;
  }

  beforeAll(async () => {
    ({ ContentService } = await import('../ContentService.ts'));
    const getPrisma = (await import('@classmoji/database')).default;
    const db = getPrisma();
    prisma = db as unknown as { $disconnect: () => Promise<void> };

    // Discover a real GitOrganization (installed GitHub App) + a classroom
    // whose content repo exists. Read-only.
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

    // Verify the content repo actually exists before writing anything.
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
    const failures: string[] = [];

    // Delete every branch we created (some are already gone — 404/422 fine).
    for (const branch of createdBranches) {
      try {
        await ContentService.deleteBranch({ gitOrganization, repo, branch });
      } catch (error: unknown) {
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 422) {
          failures.push(`deleteBranch(${branch}): ${String(error)}`);
        }
      }
    }

    // Delete the throwaway prefix from main, then ASSERT it is gone (plan
    // gate). removePrefix loops delete → settle → verify against the
    // eventually-consistent Contents API.
    try {
      await removePrefix(PREFIX);
    } catch (error: unknown) {
      failures.push(String(error));
    }

    // Branch refs must be gone too. compareBranches can serve a just-deleted
    // branch for a beat — poll.
    for (const branch of createdBranches) {
      try {
        await eventually(
          async () => {
            const still = await ContentService.compareBranches({
              gitOrganization,
              repo,
              base: 'main',
              head: branch,
            });
            if (still !== null) throw new Error(`branch ${branch} still exists`);
          },
          `branch ${branch} removed`,
          30_000
        );
      } catch (error: unknown) {
        failures.push(String(error));
      }
    }
    await prisma?.$disconnect();

    if (failures.length > 0) {
      console.error('[int-test] CLEANUP FAILURES — manual sweep needed:', failures);
    }
    expect(failures, `cleanup failures:\n${failures.join('\n')}`).toEqual([]);
  }, 300_000);

  // ───────────────────────────────────────────────────────────────────────────
  // 1. put + expectedSha
  // ───────────────────────────────────────────────────────────────────────────

  it(
    'put + expectedSha: stale sha gets 409 and never clobbers the concurrent write',
    async () => {
      const path = `${PREFIX}/cas/file.json`;
      const v1 = pretty({ group: 'cas', v: 1 });
      const v2 = pretty({ group: 'cas', v: 2 });
      const v3 = pretty({ group: 'cas', v: 3, label: 'stale-clobber-attempt' });

      const first = await ContentService.put({
        gitOrganization,
        repo,
        path,
        content: v1,
        message: '[int-test] cas v1',
      });
      expect(first.sha).toMatch(/^[0-9a-f]{40}$/);

      // Read-after-write sync point (see eventually's doc comment).
      await eventually(async () => {
        const meta = await ContentService.getMeta({ gitOrganization, repo, path, skipCache: true });
        if (meta?.sha !== first.sha) throw new Error(`meta sha ${meta?.sha} != ${first.sha}`);
      }, 'v1 visible');

      // The "concurrent" writer lands a new version.
      const second = await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: v2,
        message: '[int-test] cas v2 (concurrent)',
      });
      expect(second.sha).not.toBe(first.sha);

      // Sync until v2 is what reads serve, so the stale put below fails its
      // precheck deterministically (409) rather than tripping GitHub's own
      // write-path 422.
      await eventually(async () => {
        const meta = await ContentService.getMeta({ gitOrganization, repo, path, skipCache: true });
        if (meta?.sha !== second.sha) throw new Error(`meta sha ${meta?.sha} != ${second.sha}`);
      }, 'v2 visible');

      // A write carrying the now-stale sha must 409…
      await expect(
        ContentService.put({
          gitOrganization,
          repo,
          path,
          content: v3,
          expectedSha: first.sha,
          message: '[int-test] cas stale write',
        })
      ).rejects.toMatchObject({ status: 409 });

      // …and the concurrent write must survive untouched.
      const after = await ContentService.getContent({
        gitOrganization,
        repo,
        path,
        skipCache: true,
      });
      expect(after?.content).toBe(v2);
      expect(after?.sha).toBe(second.sha);
    },
    TEST_TIMEOUT
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 2. ref/branch plumbing
  // ───────────────────────────────────────────────────────────────────────────

  it(
    'branch plumbing: createBranch from main HEAD, branch writes invisible to main (incl. cache isolation)',
    async () => {
      const path = `${PREFIX}/branching/file.json`;
      const mainV = pretty({ group: 'branching', where: 'main' });
      const branchV = pretty({ group: 'branching', where: 'branch' });

      await ContentService.put({
        gitOrganization,
        repo,
        path,
        content: mainV,
        message: '[int-test] branching main v1',
      });

      // Read-after-write sync; this uncached read also seeds the
      // default-branch cache (setCache runs even when skipCache skips the
      // cache lookup), which the isolation assertions below rely on.
      const mainRead1 = await eventually(async () => {
        const read = await ContentService.getContent({
          gitOrganization,
          repo,
          path,
          skipCache: true,
        });
        if (read?.content !== mainV) throw new Error('main v1 not visible yet');
        return read;
      }, 'branching seed visible');

      // Self-compare trick (see pageContent.service.ensurePreviewBranch):
      // main...main yields main's HEAD without a refs call.
      const self = await ContentService.compareBranches({
        gitOrganization,
        repo,
        base: 'main',
        head: 'main',
      });
      expect(self).not.toBeNull();
      expect(self!.ahead_by).toBe(0);
      expect(self!.behind_by).toBe(0);
      expect(self!.head_sha).toBe(self!.base_sha);
      expect(self!.merge_base_sha).toBe(self!.base_sha);

      const branch = `preview/${PREFIX}/branching`;
      const created = await ContentService.createBranch({
        gitOrganization,
        repo,
        branch,
        fromSha: self!.base_sha,
      });
      createdBranches.push(branch);
      expect(created.ref).toBe(`refs/heads/${branch}`);
      expect(created.sha).toBe(self!.base_sha);

      // Write on the branch.
      const branchPut = await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: branchV,
        branch,
        message: '[int-test] branching branch write',
      });
      expect(branchPut.sha).not.toBe(mainRead1.sha);

      // Ref read returns the branch's content.
      const branchRead = await eventually(async () => {
        const read = await ContentService.getContent({
          gitOrganization,
          repo,
          path,
          ref: branch,
        });
        if (read?.sha !== branchPut.sha) throw new Error('branch write not visible yet');
        return read;
      }, 'branch write visible');
      expect(branchRead.content).toBe(branchV);

      // Cache isolation: a default-branch read after the branch write (and
      // after the ref-bearing read) must still serve MAIN's content — the
      // branch write must not have disturbed or poisoned main's cache keys.
      const mainRead2 = await ContentService.getContent({ gitOrganization, repo, path });
      expect(mainRead2?.content).toBe(mainV);
      expect(mainRead2?.sha).toBe(mainRead1.sha);

      // And an uncached main read agrees (main truly unchanged on GitHub).
      const mainRead3 = await ContentService.getContent({
        gitOrganization,
        repo,
        path,
        skipCache: true,
      });
      expect(mainRead3?.content).toBe(mainV);
    },
    TEST_TIMEOUT
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 3. mergeBranch
  // ───────────────────────────────────────────────────────────────────────────

  it(
    'mergeBranch merges disjoint changes across two files',
    async () => {
      const fileA = `${PREFIX}/merge-two-files/a.json`;
      const fileB = `${PREFIX}/merge-two-files/b.json`;

      await ContentService.put({
        gitOrganization,
        repo,
        path: fileA,
        content: pretty({ file: 'a', v: 1 }),
        message: '[int-test] merge2f seed a',
      });
      const seedB = await ContentService.put({
        gitOrganization,
        repo,
        path: fileB,
        content: pretty({ file: 'b', v: 1 }),
        message: '[int-test] merge2f seed b',
      });

      // Fork from the seed put's returned commit sha — deterministic. (A
      // compare-based main-HEAD read here raced the just-landed seed commits
      // on the first live run and forked BEFORE fileB existed, turning this
      // into an add/add conflict.)
      const branch = `preview/${PREFIX}/merge-two-files`;
      await ContentService.createBranch({
        gitOrganization,
        repo,
        branch,
        fromSha: seedB.commit,
      });
      createdBranches.push(branch);

      // Diverge: branch edits fileB, main edits fileA.
      const branchB = pretty({ file: 'b', v: 2, editedOn: 'branch' });
      await lagTolerantPut({
        gitOrganization,
        repo,
        path: fileB,
        content: branchB,
        branch,
        message: '[int-test] merge2f branch edits b',
      });
      const mainA = pretty({ file: 'a', v: 2, editedOn: 'main' });
      await lagTolerantPut({
        gitOrganization,
        repo,
        path: fileA,
        content: mainA,
        message: '[int-test] merge2f main edits a',
      });

      const result = await ContentService.mergeBranch({
        gitOrganization,
        repo,
        base: 'main',
        head: branch,
        message: '[int-test] merge2f accept',
      });
      expect(result.merged).toBe(true);
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

      // Both sides' changes present on main (polled — merge commits surface
      // through the Contents API with the same read-after-write lag).
      await eventually(async () => {
        const a = await ContentService.getContent({
          gitOrganization,
          repo,
          path: fileA,
          skipCache: true,
        });
        const b = await ContentService.getContent({
          gitOrganization,
          repo,
          path: fileB,
          skipCache: true,
        });
        if (a?.content !== mainA) throw new Error('fileA merge result not visible');
        if (b?.content !== branchB) throw new Error('fileB merge result not visible');
      }, 'two-file merge visible');

      // Cleanup lifecycle: delete the branch, verify it is gone (polled — the
      // compare API can serve a just-deleted branch for a beat).
      const del = await ContentService.deleteBranch({ gitOrganization, repo, branch });
      expect(del.deleted).toBe(true);
      await eventually(async () => {
        const gone = await ContentService.compareBranches({
          gitOrganization,
          repo,
          base: 'main',
          head: branch,
        });
        if (gone !== null) throw new Error('deleted branch still visible in compare');
      }, 'merged branch removed');
    },
    TEST_TIMEOUT
  );

  it(
    'mergeBranch auto-merges non-overlapping regions of one pretty-printed JSON file',
    async () => {
      // Shaped like a deck.json: one unit per multi-line pretty-printed
      // object, so edits to different units are far apart line-wise — the
      // §3b bet that git hunk-merge handles our real JSON shapes.
      const path = `${PREFIX}/merge-one-file/doc.json`;
      const makeDoc = (first: string, last: string) => ({
        version: 1,
        slides: [
          { id: 'slide-01', html: first, notes: 'first unit' },
          { id: 'slide-02', html: '<h1>Two</h1>', notes: 'filler' },
          { id: 'slide-03', html: '<h1>Three</h1>', notes: 'filler' },
          { id: 'slide-04', html: '<h1>Four</h1>', notes: 'filler' },
          { id: 'slide-05', html: '<h1>Five</h1>', notes: 'filler' },
          { id: 'slide-06', html: last, notes: 'last unit' },
        ],
      });

      const seed = await ContentService.put({
        gitOrganization,
        repo,
        path,
        content: pretty(makeDoc('<h1>One</h1>', '<h1>Six</h1>')),
        message: '[int-test] merge1f seed',
      });

      // Fork from the seed commit itself (deterministic; see two-file test).
      const branch = `preview/${PREFIX}/merge-one-file`;
      await ContentService.createBranch({
        gitOrganization,
        repo,
        branch,
        fromSha: seed.commit,
      });
      createdBranches.push(branch);

      // Branch edits the LAST unit; main edits the FIRST unit.
      await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: pretty(makeDoc('<h1>One</h1>', '<h1>Six — branch edit</h1>')),
        branch,
        message: '[int-test] merge1f branch edits slide-06',
      });
      await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: pretty(makeDoc('<h1>One — main edit</h1>', '<h1>Six</h1>')),
        message: '[int-test] merge1f main edits slide-01',
      });

      const result = await ContentService.mergeBranch({
        gitOrganization,
        repo,
        base: 'main',
        head: branch,
        message: '[int-test] merge1f accept',
      });
      expect(result.merged).toBe(true);

      // The merged file carries BOTH edits and is still valid JSON.
      const expectedMerged = pretty(
        makeDoc('<h1>One — main edit</h1>', '<h1>Six — branch edit</h1>')
      );
      const merged = await eventually(async () => {
        const read = await ContentService.getContent({
          gitOrganization,
          repo,
          path,
          skipCache: true,
        });
        if (read?.content !== expectedMerged) throw new Error('merged content not visible yet');
        return read;
      }, 'one-file merge visible');
      const doc = JSON.parse(merged.content) as ReturnType<typeof makeDoc>;
      expect(doc.slides[0].html).toBe('<h1>One — main edit</h1>');
      expect(doc.slides[5].html).toBe('<h1>Six — branch edit</h1>');

      await ContentService.deleteBranch({ gitOrganization, repo, branch });
    },
    TEST_TIMEOUT
  );

  it(
    'mergeBranch reports same-region conflicts without merging; the branch survives',
    async () => {
      const path = `${PREFIX}/merge-conflict/doc.json`;
      const seed = await ContentService.put({
        gitOrganization,
        repo,
        path,
        content: pretty({ id: 'slide-01', html: '<h1>base</h1>' }),
        message: '[int-test] conflict seed',
      });

      const branch = `preview/${PREFIX}/merge-conflict`;
      await ContentService.createBranch({
        gitOrganization,
        repo,
        branch,
        fromSha: seed.commit,
      });
      createdBranches.push(branch);

      // Same line changed differently on both sides.
      const branchV = pretty({ id: 'slide-01', html: '<h1>branch edit</h1>' });
      await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: branchV,
        branch,
        message: '[int-test] conflict branch edit',
      });
      const mainV = pretty({ id: 'slide-01', html: '<h1>main edit</h1>' });
      await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: mainV,
        message: '[int-test] conflict main edit',
      });

      const result = await ContentService.mergeBranch({
        gitOrganization,
        repo,
        base: 'main',
        head: branch,
        message: '[int-test] conflict accept attempt',
      });
      expect(result).toEqual({ merged: false, conflict: true });

      // Nothing merged: main still main's version.
      await eventually(async () => {
        const after = await ContentService.getContent({
          gitOrganization,
          repo,
          path,
          skipCache: true,
        });
        if (after?.content !== mainV) throw new Error('main version not visible yet');
      }, 'conflict left main untouched');

      // The branch survives the failed merge (caller can inspect/resolve).
      const stillThere = await ContentService.compareBranches({
        gitOrganization,
        repo,
        base: 'main',
        head: branch,
      });
      expect(stillThere).not.toBeNull();
      expect(stillThere!.ahead_by).toBeGreaterThanOrEqual(1);

      // Explicit discard path: delete, verify gone (polled).
      await ContentService.deleteBranch({ gitOrganization, repo, branch });
      await eventually(async () => {
        const gone = await ContentService.compareBranches({
          gitOrganization,
          repo,
          base: 'main',
          head: branch,
        });
        if (gone !== null) throw new Error('discarded branch still visible in compare');
      }, 'conflict branch removed');
    },
    TEST_TIMEOUT
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 4. uploadBatch + verifyBaseTree
  // ───────────────────────────────────────────────────────────────────────────

  it(
    'uploadBatch happy path: verifyBaseTree passes, one commit, returned blob shas ≡ getMeta shas',
    async () => {
      const existing = `${PREFIX}/batch/existing.json`;
      const fresh = `${PREFIX}/batch/fresh.html`;

      const seeded = await ContentService.put({
        gitOrganization,
        repo,
        path: existing,
        content: pretty({ v: 1 }),
        message: '[int-test] batch seed',
      });

      const nextJson = pretty({ v: 2 });
      const freshHtml = '<!doctype html>\n<html><body>batch</body></html>\n';

      let verifierRan = 0;
      const result = await ContentService.uploadBatch({
        gitOrganization,
        repo,
        files: [
          { path: existing, content: nextJson, encoding: 'utf-8' },
          { path: fresh, content: freshHtml, encoding: 'utf-8' },
        ],
        message: '[int-test] batch happy path',
        verifyBaseTree: async ({ getFileSha }) => {
          verifierRan++;
          const currentExisting = await getFileSha(existing);
          if (currentExisting !== seeded.sha) {
            throw new Error(`unexpected base sha for ${existing}: ${currentExisting}`);
          }
          const currentFresh = await getFileSha(fresh);
          if (currentFresh !== null) {
            throw new Error(`expected ${fresh} to be absent at base, got ${currentFresh}`);
          }
        },
      });

      expect(verifierRan).toBeGreaterThanOrEqual(1);
      expect(result.filesUploaded).toBe(2);
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.files).toHaveLength(2);

      // Plan §9: uploadBatch's returned blob sha must equal the Contents-API
      // file sha a subsequent getMeta reports (polled — read-after-write lag).
      for (const file of result.files) {
        await eventually(async () => {
          const meta = await ContentService.getMeta({
            gitOrganization,
            repo,
            path: file.path,
            skipCache: true,
          });
          if (meta?.sha !== file.sha) {
            throw new Error(`getMeta(${file.path}) ${meta?.sha} != blob sha ${file.sha}`);
          }
        }, `batch file ${file.path} visible`);
      }

      const landed = await ContentService.getContent({
        gitOrganization,
        repo,
        path: existing,
        skipCache: true,
      });
      expect(landed?.content).toBe(nextJson);
    },
    TEST_TIMEOUT
  );

  it(
    'uploadBatch forced-race CAS: a concurrent commit makes verifyBaseTree throw and nothing is clobbered',
    async () => {
      const path = `${PREFIX}/batch-race/target.json`;
      const v1 = pretty({ group: 'race', v: 1 });
      const v2 = pretty({ group: 'race', v: 2, author: 'concurrent-writer' });
      const clobber = pretty({ group: 'race', v: 3, author: 'stale-batch' });

      const first = await ContentService.put({
        gitOrganization,
        repo,
        path,
        content: v1,
        message: '[int-test] race seed',
      });
      const staleSha = first.sha; // what a slow writer would have read

      // The concurrent commit lands BEFORE the batch runs (deterministic
      // forcing of the race; the retry-attempt-2 timing has a unit twin).
      // lagTolerantPut: this is the same-path rapid-rewrite shape that
      // triggers GitHub's write-path 422 lag.
      const concurrent = await lagTolerantPut({
        gitOrganization,
        repo,
        path,
        content: v2,
        message: '[int-test] race concurrent commit',
      });

      let verifierRan = 0;
      class BatchConflictError extends Error {
        status = 409;
      }

      await expect(
        ContentService.uploadBatch({
          gitOrganization,
          repo,
          files: [{ path, content: clobber, encoding: 'utf-8' }],
          message: '[int-test] race stale batch (must not land)',
          verifyBaseTree: async ({ getFileSha }) => {
            verifierRan++;
            const current = await getFileSha(path);
            if (current !== staleSha) {
              throw new BatchConflictError(
                `Content changed since it was read (expected ${staleSha}, base has ${current})`
              );
            }
          },
        })
      ).rejects.toMatchObject({ status: 409 });
      expect(verifierRan).toBeGreaterThanOrEqual(1);

      // The concurrent write survives — the stale batch never landed.
      await eventually(async () => {
        const after = await ContentService.getContent({
          gitOrganization,
          repo,
          path,
          skipCache: true,
        });
        if (after?.sha !== concurrent.sha) {
          throw new Error(`post-race sha ${after?.sha} != concurrent ${concurrent.sha}`);
        }
        if (after.content !== v2) throw new Error('post-race content is not the concurrent write');
      }, 'concurrent write survived');
    },
    TEST_TIMEOUT
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 6. compareBranches sanity
  // ───────────────────────────────────────────────────────────────────────────

  it(
    'compareBranches: ahead/behind/merge-base on a branch with one extra commit',
    async () => {
      const forkPoint = await mainHeadSha();
      const branch = `preview/${PREFIX}/compare`;
      await ContentService.createBranch({ gitOrganization, repo, branch, fromSha: forkPoint });
      createdBranches.push(branch);

      const put = await ContentService.put({
        gitOrganization,
        repo,
        path: `${PREFIX}/compare/extra.json`,
        content: pretty({ group: 'compare', extra: true }),
        branch,
        message: '[int-test] compare branch commit',
      });

      const cmp = await eventually(async () => {
        const result = await ContentService.compareBranches({
          gitOrganization,
          repo,
          base: 'main',
          head: branch,
        });
        if (!result) throw new Error('compare returned null');
        if (result.ahead_by !== 1) throw new Error(`ahead_by ${result.ahead_by} != 1 yet`);
        return result;
      }, 'branch commit visible in compare');
      expect(cmp.behind_by).toBeGreaterThanOrEqual(0); // main may move under parallel runs
      expect(cmp.merge_base_sha).toBe(forkPoint);
      expect(cmp.head_sha).toBe(put.commit);
      expect(cmp.commits).toHaveLength(1);
      expect(cmp.commits[0].sha).toBe(put.commit);
      expect(cmp.commits[0].date).toBeTruthy();

      await ContentService.deleteBranch({ gitOrganization, repo, branch });
    },
    TEST_TIMEOUT
  );
});
