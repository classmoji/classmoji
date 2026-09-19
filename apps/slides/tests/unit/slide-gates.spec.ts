/**
 * Unit tests for the GATES around a slide that is not a deck.
 *
 * A slide can be a deck, an uploaded document or a link, and the three are
 * reached through the same `/{slideId}` URL — so every screen and every byte
 * path in this app now has to answer two questions in a fixed order: may this
 * person see this slide, and only then, what kind of thing is it?
 *
 * The loaders themselves need Postgres and a content repo, so what is pinned
 * here is what they are BUILT OUT OF — the pure rules, each factored into a
 * module of its own — plus the structural invariants that only a source read
 * can check. Each one exists because getting it wrong is silent:
 *
 *   - the ORDER. A kind branch that ran before `assertSlideAccess` would serve
 *     a draft document to anyone who knew a slide id, and every test of the
 *     branch itself would still pass.
 *   - the SEPARATOR in a path prefix. `slides/week-1` is a prefix of
 *     `slides/week-10`, and instructors number their slugs exactly that way.
 *   - the file-slide rule in the content proxy. That route authorizes a PATH
 *     against a REPO, which is right for a deck's images and wrong for a
 *     document whose slide carries its own draft/private/public setting.
 *   - one REFUSAL per surface. Two literals drift, and the drift is an oracle
 *     for which paths and which slides exist.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { SLIDE_SOURCE_UNAVAILABLE, slideFileUnavailable } from '../../app/utils/slideKind.ts';
import {
  couldBeSlideDocument,
  isWithinContentPath,
  slideDocumentDecision,
  slideDocumentRedirect,
} from '../../app/utils/slideDocumentAccess.ts';
import {
  assertSlideInClassroom,
  assertSlideKind,
} from '../../app/utils/slideRouteGuards.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const VIEWER_SOURCE = source('../../app/routes/$slideId/route.tsx');
const DOWNLOAD_SOURCE = source('../../app/routes/$slideId_.download/route.ts');
const PROXY_SOURCE = source('../../app/routes/content.$org.$repo.$/route.tsx');
const REPLACE_SOURCE = source('../../app/routes/$classroomSlug.$slideId.replace/route.tsx');
const LINK_SOURCE = source('../../app/routes/$classroomSlug.$slideId.link/route.tsx');
const NEW_SOURCE = source('../../app/routes/$classroomSlug.new/route.tsx');
const IMPORT_SOURCE = source('../../app/routes/api.slides.import.start/route.ts');
const INDEX_SOURCE = source('../../app/routes/_index/route.tsx');
const FOLLOW_SOURCE = source('../../app/routes/$slideId_.follow/route.tsx');
const PRESENT_SOURCE = source('../../app/routes/$slideId_.present/route.tsx');
const SPEAKER_SOURCE = source('../../app/routes/$slideId_.speaker/route.tsx');

/** The `Response` a guard threw, or a failure if it did not throw one. */
function thrownResponse(run: () => void): Response {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error('expected the guard to throw a Response');
}

/**
 * The upload policy's list.
 *
 * Restated rather than imported so these tests stay free of the deck engine,
 * and then checked against the real constant below — a filter that fell behind
 * the policy would quietly stop applying to whatever extension was added.
 */
const SLIDE_DOCUMENT_EXTENSIONS = ['pdf', 'ppt', 'pptx', 'key'] as const;

function expectNoStoreAndNoReferrer(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. `/{slideId}` — the viewer
// ─────────────────────────────────────────────────────────────────────────────

test.describe('the slide viewer', () => {
  test('decides access BEFORE it looks at the kind', () => {
    // The whole reason the kind branch is where it is: a file slide's redirect
    // and a link slide's offsite hop must be unreachable for a viewer the gate
    // would have refused. If these two ever swap, a draft document is one
    // guessed slide id away from anybody.
    const gate = VIEWER_SOURCE.indexOf("accessType: 'view',");
    const kindBranch = VIEWER_SOURCE.indexOf('if (!isDeckSlide(slide))');

    expect(gate).toBeGreaterThan(-1);
    expect(kindBranch).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(kindBranch);
  });

  test('builds every non-deck answer from the shared header set', () => {
    // `nonDeckHeaders` is what puts `no-store` and `no-referrer` on these. A
    // hand-rolled `{ Location }` on any one of them is how a signed URL minted
    // for one viewer ends up cached for the next.
    expect(VIEWER_SOURCE).toContain('headers: nonDeckHeaders({ Location: signed.url })');
    expect(VIEWER_SOURCE).toContain(
      'headers: nonDeckHeaders({ Location: `/${encodeURIComponent(slideId)}/download` })'
    );
    // The LINK answer comes from the shared builder rather than a literal.
    expect(VIEWER_SOURCE).toContain('return slideLinkRedirect(slide.source_url)');
    // And the refusal is the same function the download route uses.
    expect(VIEWER_SOURCE).toContain('throw slideFileUnavailable()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. `/{slideId}/download` — the bytes
// ─────────────────────────────────────────────────────────────────────────────

test.describe('the download route', () => {
  test('re-runs the view gate before anything else', () => {
    // It is a perfectly good direct link, not just the tail of a redirect, so
    // it cannot treat the hop that reached it as a credential. The gate has to
    // come before the kind check AND before the file is opened.
    const gate = DOWNLOAD_SOURCE.indexOf('await assertSlideAccess(');
    const kindCheck = DOWNLOAD_SOURCE.indexOf("slide.kind !== 'FILE'");
    const open = DOWNLOAD_SOURCE.indexOf('openSlideFile(slide)');

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(kindCheck);
    expect(kindCheck).toBeLessThan(open);
  });

  test('refuses a deck or a link with the shared 404', () => {
    // The same builder for "this is a deck", "this is a link" and "this file
    // cannot be resolved", so the three cannot be told apart by their answers.
    expect(DOWNLOAD_SOURCE).toContain('return slideFileUnavailable();');

    const refusal = slideFileUnavailable();
    expect(refusal.status).toBe(404);
    expect(refusal.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(refusal.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expectNoStoreAndNoReferrer(refusal);
  });

  test('says the same sentence the viewer says', async () => {
    expect(await slideFileUnavailable().text()).toBe(SLIDE_SOURCE_UNAVAILABLE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The staff screens — replace and edit-link
// ─────────────────────────────────────────────────────────────────────────────

test.describe('the classroom guard', () => {
  test('refuses classroom A’s path on classroom B’s slide', () => {
    const refusal = thrownResponse(() =>
      assertSlideInClassroom({ kind: 'FILE', classroom: { slug: 'cs52' } }, 'cs98')
    );
    expect(refusal.status).toBe(403);
  });

  test('refuses a slide with no classroom at all', () => {
    expect(thrownResponse(() => assertSlideInClassroom({ kind: 'FILE' }, 'cs52')).status).toBe(403);
  });

  test('passes the slide’s own classroom', () => {
    expect(() =>
      assertSlideInClassroom({ kind: 'FILE', classroom: { slug: 'cs52' } }, 'cs52')
    ).not.toThrow();
  });
});

test.describe('the kind guard', () => {
  test('404s a deck on the replace screen, in the screen’s own words', async () => {
    const refusal = thrownResponse(() =>
      assertSlideKind({ kind: 'DECK' }, 'FILE', 'This slide has no file to replace.')
    );
    expect(refusal.status).toBe(404);
    expect(await refusal.text()).toBe('This slide has no file to replace.');
  });

  test('404s a file on the edit-link screen', async () => {
    const refusal = thrownResponse(() =>
      assertSlideKind({ kind: 'FILE' }, 'LINK', 'This slide has no link to edit.')
    );
    expect(refusal.status).toBe(404);
    expect(await refusal.text()).toBe('This slide has no link to edit.');
  });

  test('passes the kind the screen is for', () => {
    expect(() => assertSlideKind({ kind: 'LINK' }, 'LINK', 'nope')).not.toThrow();
  });
});

test.describe('the staff screens', () => {
  test('gate the ACTION as well as the loader', () => {
    // A loader is not a mutation boundary: React Router matches only the action
    // route for a submission. Each action re-runs the whole authorize helper.
    for (const routeSource of [REPLACE_SOURCE, LINK_SOURCE]) {
      const calls = routeSource.match(/await authorize(FileSlide|LinkSlide)\(/g) ?? [];
      expect(calls.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('run the access gate before the ownership and kind checks', () => {
    for (const routeSource of [REPLACE_SOURCE, LINK_SOURCE]) {
      const gate = routeSource.indexOf('await assertSlideAccess(');
      const belongs = routeSource.indexOf('assertSlideInClassroom(slide');
      expect(gate).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(belongs);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The content proxy
// ─────────────────────────────────────────────────────────────────────────────

test.describe('a public slide’s folder', () => {
  test('is matched on the separator, not on the characters', () => {
    // The bug this replaces: `'slides/week-10/notes.png'.startsWith('slides/week-1')`
    // is true, so a public `week-1` deck authorized every asset of `week-10`.
    expect(isWithinContentPath('slides/week-10/notes.png', 'slides/week-1')).toBe(false);
    expect(isWithinContentPath('slides/week-1-extra/notes.png', 'slides/week-1')).toBe(false);
    expect(isWithinContentPath('slides/week-1/notes.png', 'slides/week-1')).toBe(true);
    expect(isWithinContentPath('slides/week-1', 'slides/week-1')).toBe(true);
  });

  test('is never matched by an empty content path', () => {
    // A row with no content path must authorize NOTHING, rather than every path
    // in the repo the way a bare `startsWith('')` would.
    expect(isWithinContentPath('slides/week-1/notes.png', '')).toBe(false);
    expect(isWithinContentPath('slides/week-1/notes.png', null)).toBe(false);
  });
});

test.describe('a file slide’s document reached through the proxy', () => {
  const draftDocument = 'slides/week-3/week-3-lecture.pdf';

  test('is only looked up for a path that could be one', async () => {
    // The proxy serves fonts, stylesheets and images by the dozen per page and
    // caches memberships for eight hours so that none of them touches the
    // database. A query per asset would undo exactly that.
    expect(couldBeSlideDocument('slides/week-3/week-3-lecture.pdf', SLIDE_DOCUMENT_EXTENSIONS)).toBe(
      true
    );
    expect(couldBeSlideDocument('slides/week-3/index.html', SLIDE_DOCUMENT_EXTENSIONS)).toBe(false);
    expect(couldBeSlideDocument('.slidesthemes/x/lib/offline-v2.css', SLIDE_DOCUMENT_EXTENSIONS)).toBe(
      false
    );
    expect(couldBeSlideDocument('slides/week-3/images/diagram', SLIDE_DOCUMENT_EXTENSIONS)).toBe(
      false
    );
    // Case is the filename's, not the policy's.
    expect(couldBeSlideDocument('slides/week-3/Lecture.PDF', SLIDE_DOCUMENT_EXTENSIONS)).toBe(true);

    let looked = false;
    const decision = await slideDocumentDecision({
      path: 'slides/week-3/theme.css',
      extensions: SLIDE_DOCUMENT_EXTENSIONS,
      classroomIds: ['classroom-1'],
      findFileSlides: async () => {
        looked = true;
        return [];
      },
      assertView: async () => undefined,
    });

    expect(decision.outcome).toBe('pass');
    expect(looked).toBe(false);
  });

  test('is not looked up at all when no classroom was matched', async () => {
    let looked = false;
    const decision = await slideDocumentDecision({
      path: draftDocument,
      extensions: SLIDE_DOCUMENT_EXTENSIONS,
      classroomIds: [],
      findFileSlides: async () => {
        looked = true;
        return [];
      },
      assertView: async () => undefined,
    });

    expect(decision.outcome).toBe('pass');
    expect(looked).toBe(false);
  });

  test('passes a path no file slide claims', async () => {
    // A deck's index.html, its images and the shared themes still go straight
    // through — this rule is about documents, and nothing else changes.
    const decision = await slideDocumentDecision({
      path: 'slides/week-3/index.html',
      extensions: SLIDE_DOCUMENT_EXTENSIONS,
      classroomIds: ['classroom-1'],
      findFileSlides: async () => [],
      assertView: async () => undefined,
    });

    expect(decision.outcome).toBe('pass');
  });

  test('refuses a draft document for a student', async () => {
    // The student is a member of the classroom, so the repo-level branches in
    // the route said yes. The slide's own gate is the one that says no, and its
    // refusal is the route's ordinary one — no new answer to tell it apart by.
    const decision = await slideDocumentDecision({
      path: draftDocument,
      extensions: SLIDE_DOCUMENT_EXTENSIONS,
      classroomIds: ['classroom-1'],
      findFileSlides: async () => [{ id: 'slide-draft' }],
      assertView: async () => {
        throw new Response('Forbidden', { status: 403 });
      },
    });

    expect(decision.outcome).toBe('refuse');
  });

  test('redirects staff to the gated viewer instead of serving the bytes', async () => {
    const decision = await slideDocumentDecision({
      path: draftDocument,
      extensions: SLIDE_DOCUMENT_EXTENSIONS,
      classroomIds: ['classroom-1'],
      findFileSlides: async () => [{ id: 'slide-draft' }],
      assertView: async () => undefined,
    });

    expect(decision.outcome).toBe('redirect');
    if (decision.outcome !== 'redirect') return;
    expect(decision.response.status).toBe(302);
    expect(decision.response.headers.get('Location')).toBe('/slide-draft');
    // `/{slideId}` names the download and marks it no-store; this route serves
    // inline under `Cache-Control: public`, which is the whole reason for the
    // hop.
    expectNoStoreAndNoReferrer(decision.response);
  });

  test('checks EVERY classroom that holds the path, not just the first', async () => {
    // One content repo can back several classrooms (the org-level fallback is
    // org-wide). Refusing because the first row said no would hide a document
    // from the staff member looking straight at it.
    const seen: string[] = [];
    const decision = await slideDocumentDecision({
      path: draftDocument,
      extensions: SLIDE_DOCUMENT_EXTENSIONS,
      classroomIds: ['classroom-1', 'classroom-2'],
      findFileSlides: async () => [{ id: 'other-classroom' }, { id: 'mine' }],
      assertView: async slide => {
        seen.push(slide.id);
        if (slide.id === 'other-classroom') throw new Response('Forbidden', { status: 403 });
        return undefined;
      },
    });

    expect(seen).toEqual(['other-classroom', 'mine']);
    expect(decision.outcome).toBe('redirect');
    if (decision.outcome !== 'redirect') return;
    expect(decision.response.headers.get('Location')).toBe('/mine');
  });

  test('uses the same extension list the upload policy enforces', () => {
    // Read out of the policy's own source: importing it here would drag
    // `@classmoji/services/slides` — cheerio and the deck engine — into a unit
    // test that needs four strings.
    const policy = source('../../../../packages/services/src/slides/slideSource.ts');
    const declared = policy.match(/SLIDE_FILE_EXTENSIONS = \[([^\]]*)\]/);
    expect(declared).not.toBeNull();
    const listed = (declared?.[1] ?? '')
      .split(',')
      .map(part => part.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(listed).toEqual([...SLIDE_DOCUMENT_EXTENSIONS]);
  });

  test('escapes the slide id it redirects to', () => {
    expect(slideDocumentRedirect('a/b?c').headers.get('Location')).toBe('/a%2Fb%3Fc');
  });
});

test.describe('the content proxy route', () => {
  test('applies the file-slide rule after access and before the fetch', () => {
    const decision = PROXY_SOURCE.indexOf('await slideDocumentDecision(');
    const accessCheck = PROXY_SOURCE.indexOf('if (!hasAccess)');
    const fetchText = PROXY_SOURCE.indexOf('const binary = isBinaryFile(path)');

    expect(decision).toBeGreaterThan(-1);
    expect(accessCheck).toBeLessThan(decision);
    expect(decision).toBeLessThan(fetchText);
  });

  test('applies it to BOTH branches, by collecting ids in each', () => {
    // The membership branch and the public-slide branch each set the classroom
    // ids the rule is looked up in. A branch that forgot would serve a document
    // to whoever took that path.
    const assignments = PROXY_SOURCE.match(/authorizedClassroomIds = /g) ?? [];
    expect(assignments.length).toBe(2);
  });

  test('has exactly one refusal', () => {
    // A second `status: 403` literal is how the answer for "you may not have
    // this path" and the answer for "you may not have this document" start to
    // differ — and the difference is an oracle for which documents exist.
    expect(PROXY_SOURCE.match(/status: 403/g)).toHaveLength(1);
    expect(PROXY_SOURCE.match(/throw forbidden\(\);/g)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The upload endpoints
// ─────────────────────────────────────────────────────────────────────────────

test.describe('the upload endpoints', () => {
  test('take a slot and give it back in a finally', () => {
    // Without the `finally` a failed upload leaks its slot, and after two of
    // those the route refuses everybody forever.
    for (const routeSource of [NEW_SOURCE, REPLACE_SOURCE]) {
      expect(routeSource).toContain('if (!acquireUploadSlot())');
      expect(routeSource).toContain('} finally {\n    releaseUploadSlot();');
      expect(routeSource).toContain("headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) }");
      expect(routeSource).toContain('status: 503');
    }
  });

  test('never fall back to a blank deck for an unrecognised source', () => {
    // The old line was `rawSource === 'file' || rawSource === 'link' ? … : 'blank'`,
    // so a submission whose `source` field was missing or misspelled created an
    // empty deck and reported success.
    expect(NEW_SOURCE).toContain('SLIDE_SOURCES.includes(rawSource as SlideSource)');
    expect(NEW_SOURCE).not.toContain("formData.get('source') ?? 'blank'");
  });

  test('the import endpoint checks a session and meters the body', () => {
    // The classroom arrives as a form field, so its own gate cannot run first —
    // but a session can, and the 150 MB cap must be enforced while the body
    // streams rather than trusted to `Content-Length`.
    const session = IMPORT_SOURCE.indexOf('await getAuthSession(request)');
    const read = IMPORT_SOURCE.indexOf('await readLimitedFormData(');

    expect(session).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(session).toBeLessThan(read);
    // And nothing reads the body the unmetered way. (The header comment names
    // `request.formData()` to explain why, so this looks for the CALL.)
    expect(IMPORT_SOURCE).not.toContain('await request.formData()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. What the loaders send the browser
// ─────────────────────────────────────────────────────────────────────────────

test.describe('the page payloads', () => {
  test('no loader spreads a whole slide row', () => {
    // Every column of `Slide` is serialized into the HTML by a spread — the
    // multiplex credentials, a file slide's repo path, a link's destination.
    // Each of these loaders names its fields instead.
    for (const routeSource of [INDEX_SOURCE, FOLLOW_SOURCE, PRESENT_SOURCE, SPEAKER_SOURCE]) {
      expect(routeSource).not.toContain('      ...slide,\n');
      // `return {` followed straight by the row. (A bare `slide,` elsewhere is
      // an argument — `assertSlideAccess({ request, slideId, slide, … })`.)
      expect(routeSource).not.toContain('  return {\n    slide,\n');
    }
  });

  test('only the presenter is handed the multiplex secret', () => {
    // It is the credential that DRIVES a presentation. A follower holding a
    // share code must never receive it, and neither must the speaker view.
    expect(PRESENT_SOURCE).toContain('multiplex_secret: slide.multiplex_secret');
    expect(FOLLOW_SOURCE).not.toContain('multiplex_secret: slide.multiplex_secret');
    expect(SPEAKER_SOURCE).not.toContain('multiplex_secret: slide.multiplex_secret');
  });

  test('the index sends cards, built in one place', () => {
    expect(INDEX_SOURCE).toContain('toSlideCard(slide, thumbnails.get(slide.id) ?? null)');
    // The duplicate action prepends its result to the same list, so it goes
    // through the same mapper rather than shipping a fresh Prisma row.
    expect(INDEX_SOURCE).toContain('newSlide: toSlideCard(newSlide)');
  });
});
