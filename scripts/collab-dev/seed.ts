/**
 * Live-editing dev seed for classroom `musashibot-testing` (devport DB only).
 *
 *   npx dotenv -e .env -- ./scripts/devport.sh run \
 *     node --experimental-strip-types scripts/collab-dev/seed.ts [--db-only]
 *
 * (`devport.sh run` sets the devport DATABASE_URL and app URLs but does not
 * read `.env`; `dotenv` supplies the GitHub App credentials the content
 * services need. The dev stack does NOT have to be running: page and deck
 * creation talk to GitHub directly with the installation token.)
 *
 * Steps — every one idempotent, safe to re-run:
 *   1. `collab_enabled = true` on the classroom.
 *   2. Users collab-teacher-1, collab-teacher-2 (TEACHER) and collab-assistant
 *      (ASSISTANT) with a github account row (fake id, no token) and an
 *      accepted membership. Sign in as them with /test-login?as=<login>.
 *   3. Pages "Plain collab page" and "Kitchen sink page" (every block type,
 *      cover image, assets uploaded into the content repo).
 *   4. Decks "Plain collab deck" (starter) and "Kitchen sink deck" (17 root
 *      slides + a 3-slide vertical stack).
 *   `--db-only` stops after step 2.
 *
 * Content is written ONLY while the document has no collab_docs row: once a
 * room has opened, the live document is the source of truth, and rewriting
 * the git file underneath it would be an outside push. A page/deck that
 * exists but lacks the seed's content (an interrupted earlier run) is filled
 * in; one that already has it is left alone.
 */
import { readFileSync } from 'node:fs';

import getPrisma from '@classmoji/database';
import { upsertGithubUser } from '@classmoji/database/seed-fixtures';
import { ClassmojiService } from '@classmoji/services';
import { loadDeck, parseDeckHtml, saveDeck, slideService } from '@classmoji/services/slides';

import {
  CLASSROOM_ID,
  CLASSROOM_REF,
  COLLAB_USERS,
  KITCHEN_SINK_DECK_TITLE,
  KITCHEN_SINK_PAGE_TITLE,
  OWNER_LOGIN,
  PAGE_TARGET_TEXT,
  PLAIN_DECK_TITLE,
  PLAIN_PAGE_TITLE,
  DECK_SLIDE_A_TEXT,
} from './constants.ts';
import { kitchenSinkDeckHtml } from './kitchenSinkDeck.ts';

const prisma = getPrisma();
const dbOnly = process.argv.includes('--db-only');

const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3010';
const PAGES_URL = process.env.PAGES_URL || 'http://localhost:7110';
const SLIDES_URL = process.env.SLIDES_URL || 'http://localhost:6510';

/** F0's kitchen-sink page fixture (packages/page-schema) — the seed reuses it. */
const PAGE_FIXTURE = new URL(
  '../../packages/page-schema/src/__tests__/fixtures/kitchen-sink.content.json',
  import.meta.url
);

const AUDIO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3';
const VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

type Block = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
};

function log(step: string, message: string) {
  console.warn(`[collab-seed] ${step}: ${message}`);
}

// ─── 1 + 2: flag and users ──────────────────────────────────────────────────

async function seedClassroomAndUsers() {
  const classroom = await prisma.classroom.findUnique({
    where: { id: CLASSROOM_ID },
    include: { git_organization: true },
  });
  if (!classroom) {
    throw new Error(
      `Classroom ${CLASSROOM_ID} not found — is DATABASE_URL the devport database? (got ${process.env.DATABASE_URL})`
    );
  }
  if (!classroom.collab_enabled) {
    await prisma.classroom.update({ where: { id: classroom.id }, data: { collab_enabled: true } });
    log('flag', `collab_enabled = true on ${classroom.slug}`);
  } else {
    log('flag', `collab_enabled already true on ${classroom.slug}`);
  }

  for (const u of COLLAB_USERS) {
    const user = await upsertGithubUser(prisma, {
      login: u.login,
      githubId: u.githubId,
      name: u.name,
      email: u.email,
      school_id: 'collab-dev',
    });
    await prisma.classroomMembership.upsert({
      where: {
        classroom_id_user_id_role: { classroom_id: classroom.id, user_id: user.id, role: u.role },
      },
      update: { has_accepted_invite: true },
      create: {
        classroom_id: classroom.id,
        user_id: user.id,
        role: u.role,
        has_accepted_invite: true,
      },
    });
    log('users', `${u.login} (${u.role}) → user ${user.id}`);
  }
  return classroom;
}

async function ownerUserId(): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { provider_id: 'github', username: OWNER_LOGIN },
    select: { user_id: true },
  });
  if (!account) throw new Error(`Owner ${OWNER_LOGIN} has no github account row in this database`);
  return account.user_id;
}

async function hasLiveDoc(kind: 'page' | 'deck', docId: string): Promise<boolean> {
  const row = await prisma.collabDoc.findUnique({
    where: { kind_doc_id: { kind, doc_id: docId } },
    select: { doc_id: true },
  });
  return row !== null;
}

// ─── 3: pages ───────────────────────────────────────────────────────────────

async function ensurePage(title: string, createdBy: string) {
  const existing = await prisma.page.findFirst({
    where: { classroom_id: CLASSROOM_ID, title },
    select: { id: true },
  });
  if (existing) {
    log('pages', `"${title}" exists (${existing.id})`);
    return existing.id;
  }
  const created = await ClassmojiService.page.createPage({
    classroomId: CLASSROOM_ID,
    title,
    createdBy,
  });
  log('pages', `created "${title}" (${created.id})`);
  return created.id;
}

async function loadPage(pageId: string) {
  const page = await ClassmojiService.page.findById(pageId);
  if (!page) throw new Error(`Page ${pageId} vanished`);
  return page as unknown as Parameters<typeof ClassmojiService.pageContent.savePageContent>[0];
}

/** True when the page's content.json already carries `marker`. */
async function pageHasMarker(pageId: string, marker: string): Promise<boolean> {
  const page = await loadPage(pageId);
  const content = await ClassmojiService.pageContent.loadPageContent(page, { skipCache: true });
  return content.format === 'json' && JSON.stringify(content.blocks).includes(marker);
}

const para = (id: string, text: string): Block => ({
  id,
  type: 'paragraph',
  props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

const heading = (id: string, level: number, text: string): Block => ({
  id,
  type: 'heading',
  props: {
    backgroundColor: 'default',
    textColor: 'default',
    textAlignment: 'left',
    level,
    isToggleable: false,
  },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

async function seedPlainPage(createdBy: string): Promise<string> {
  const pageId = await ensurePage(PLAIN_PAGE_TITLE, createdBy);
  const marker = 'A plain page for simple live-editing tests.';
  if (await hasLiveDoc('page', pageId)) {
    log('pages', `"${PLAIN_PAGE_TITLE}" has a live document — content left alone`);
  } else if (await pageHasMarker(pageId, marker)) {
    log('pages', `"${PLAIN_PAGE_TITLE}" already seeded`);
  } else {
    const page = await loadPage(pageId);
    await ClassmojiService.pageContent.savePageContent(
      page,
      [
        heading('plain-h1', 1, PLAIN_PAGE_TITLE),
        para('plain-p1', marker),
        para('plain-p2', 'Second paragraph.'),
        para('plain-p3', 'Third paragraph.'),
      ],
      { coverImage: null, message: `Seed page: ${PLAIN_PAGE_TITLE}` }
    );
    log('pages', `wrote "${PLAIN_PAGE_TITLE}" content`);
  }
  return pageId;
}

/** A small labelled SVG, so every image block shows something recognisable. */
function svg(label: string, fill: string, width = 640, height = 360): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect width="100%" height="100%" fill="${fill}"/>` +
      `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(height / 8)}" ` +
      `text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`
  );
}

/** A one-page PDF reading "Syllabus" (hand-built; offsets are exact). */
function syllabusPdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // content stream, filled below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 36 Tf 72 700 Td (Syllabus) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function seedKitchenSinkPage(createdBy: string, plainPageId: string): Promise<string> {
  const pageId = await ensurePage(KITCHEN_SINK_PAGE_TITLE, createdBy);
  if (await hasLiveDoc('page', pageId)) {
    log('pages', `"${KITCHEN_SINK_PAGE_TITLE}" has a live document — content left alone`);
    return pageId;
  }
  if (await pageHasMarker(pageId, PAGE_TARGET_TEXT)) {
    log('pages', `"${KITCHEN_SINK_PAGE_TITLE}" already seeded`);
    return pageId;
  }

  const page = await loadPage(pageId);

  // Assets go into the content repo through the same upload path the editor
  // uses. `storedName` makes a re-run skip files already committed.
  const uploads: Array<[string, Buffer, string]> = [
    ['cover', svg('Kitchen sink cover', '#4f46e5', 1600, 400), 'cover.svg'],
    ['diagram', svg('Diagram', '#0f766e'), 'diagram.svg'],
    ['right', svg('Right column', '#b45309', 400, 300), 'right.svg'],
    ['ada', svg('AL', '#7c3aed', 256, 256), 'ada.svg'],
    ['syllabus', syllabusPdf(), 'syllabus.pdf'],
  ];
  const urls: Record<string, string> = {};
  for (const [key, buffer, filename] of uploads) {
    const uploaded = await ClassmojiService.pageContent.uploadPageAsset(page, buffer, filename, {
      storedName: filename,
    });
    urls[key] = uploaded.url;
    log('pages', `asset ${filename} → ${uploaded.url}`);
  }

  // Rewrite the fixture's placeholder references to things that resolve here.
  const fixture = readFileSync(PAGE_FIXTURE, 'utf8')
    .replaceAll('assets/cover.jpg', urls.cover)
    .replaceAll('assets/diagram.png', urls.diagram)
    .replaceAll('assets/right.png', urls.right)
    .replaceAll('assets/ada.jpg', urls.ada)
    .replaceAll('assets/syllabus.pdf', urls.syllabus)
    .replaceAll('media://audio-1', AUDIO_URL)
    .replaceAll('media://video-1', VIDEO_URL)
    .replaceAll('https://codesandbox.io/embed/abc', 'https://example.com')
    .replaceAll('11111111-2222-3333-4444-555555555555', plainPageId)
    .replaceAll('"Week 1"', JSON.stringify(PLAIN_PAGE_TITLE))
    .replaceAll('\\"Week 1\\"', JSON.stringify(JSON.stringify(PLAIN_PAGE_TITLE)).slice(1, -1));
  const parsed = JSON.parse(fixture) as {
    blocks: Block[];
    coverImage?: { url: string; position: number };
  };

  // The shared paragraph the acceptance spec types into sits right under the
  // title, where both editors can reach it without scrolling.
  const blocks = [...parsed.blocks];
  blocks.splice(1, 0, para('collab-target', PAGE_TARGET_TEXT));

  await ClassmojiService.pageContent.savePageContent(page, blocks, {
    coverImage: parsed.coverImage ?? { url: urls.cover, position: 50 },
    message: `Seed page: ${KITCHEN_SINK_PAGE_TITLE}`,
  });
  log('pages', `wrote "${KITCHEN_SINK_PAGE_TITLE}" content (${blocks.length} top-level blocks)`);
  return pageId;
}

// ─── 4: decks ───────────────────────────────────────────────────────────────

async function ensureDeck(title: string, createdBy: string): Promise<string> {
  const existing = await prisma.slide.findFirst({
    where: { classroom_id: CLASSROOM_ID, title },
    select: { id: true },
  });
  if (existing) {
    log('decks', `"${title}" exists (${existing.id})`);
    return existing.id;
  }
  const { slide } = await slideService.createSlide({ classroomId: CLASSROOM_ID, title, createdBy });
  log('decks', `created "${title}" (${slide.id})`);
  return slide.id;
}

async function seedKitchenSinkDeck(createdBy: string): Promise<string> {
  const slideId = await ensureDeck(KITCHEN_SINK_DECK_TITLE, createdBy);
  // The assistant can join this deck (OWNER/TEACHER can join any deck).
  await slideService.updateSlide(slideId, { allow_team_edit: true });

  if (await hasLiveDoc('deck', slideId)) {
    log('decks', `"${KITCHEN_SINK_DECK_TITLE}" has a live document — content left alone`);
    return slideId;
  }

  const target = await slideService.findById(slideId);
  if (!target) throw new Error(`Slide ${slideId} vanished`);
  const current = await loadDeck(target as never, { skipCache: true });
  if (current.deck.slides.some(s => s.html?.includes(DECK_SLIDE_A_TEXT))) {
    log('decks', `"${KITCHEN_SINK_DECK_TITLE}" already seeded`);
    return slideId;
  }

  const { deck: parsed, warnings } = parseDeckHtml(kitchenSinkDeckHtml());
  for (const w of warnings) log('decks', `parse warning: ${w}`);

  // Keep the starter's meta (theme, config, custom CSS); replace the slides.
  const deck = { ...current.deck, slides: parsed.slides };
  await saveDeck({
    slide: target as never,
    deck,
    expectedSha: current.sha,
    shaSource: current.sha_source,
    message: `Seed deck: ${KITCHEN_SINK_DECK_TITLE}`,
  });
  const count = deck.slides.reduce((n, s) => n + 1 + (s.children?.length ?? 0), 0);
  log('decks', `wrote "${KITCHEN_SINK_DECK_TITLE}" (${deck.slides.length} root, ${count} total)`);
  return slideId;
}

// ─── main ───────────────────────────────────────────────────────────────────

function loginLink(login: string, path?: string): string {
  const q = new URLSearchParams({ as: login });
  if (path) q.set('redirect', path);
  return `${WEBAPP_URL}/test-login?${q.toString()}`;
}

async function main() {
  const classroom = await seedClassroomAndUsers();
  if (dbOnly) {
    log('done', '--db-only: skipped pages and decks');
  } else {
    const owner = await ownerUserId();
    const plainPageId = await seedPlainPage(owner);
    const pageId = await seedKitchenSinkPage(owner, plainPageId);
    const plainDeckId = await ensureDeck(PLAIN_DECK_TITLE, owner);
    const deckId = await seedKitchenSinkDeck(owner);

    console.warn('\nContent (open after signing in):');
    console.warn(`  Kitchen sink page  ${PAGES_URL}/${classroom.slug}/${pageId}`);
    console.warn(`  Plain page         ${PAGES_URL}/${classroom.slug}/${plainPageId}`);
    console.warn(`  Kitchen sink deck  ${SLIDES_URL}/${deckId}?mode=edit`);
    console.warn(`  Plain deck         ${SLIDES_URL}/${plainDeckId}?mode=edit`);
  }

  console.warn('\nSign in (one browser profile / private window each):');
  console.warn(
    `  ${OWNER_LOGIN.padEnd(18)} ${loginLink(OWNER_LOGIN)}  (or your normal GitHub login)`
  );
  for (const u of COLLAB_USERS) {
    console.warn(`  ${u.login.padEnd(18)} ${loginLink(u.login)}`);
  }
  console.warn(`\nMCP classroom ref: ${CLASSROOM_REF}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async error => {
    console.error('[collab-seed] failed:', error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
