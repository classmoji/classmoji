/**
 * Dev fixture for the Ask Moji walkthrough (plan §7.4 step 1).
 *
 * Seeds the dev classroom with one PUBLISHED page and one DRAFT page, records
 * their asset-map rows, and indexes both through the real indexer, so the
 * content tools have something to find and a draft to withhold:
 *
 *   student  "when is the midterm?"        → cites Course Schedule, never Midterm Solutions
 *   staff    "what's the answer to Q1?"    → reaches the draft
 *
 * No GitHub write: `content_get` serves the indexed text, so the pages never
 * need to exist in a content repo. Needs CLOUDFLARE_WORKERS_AI_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID for the embeddings.
 *
 * Idempotent: re-running replaces the two pages (cascade clears their index rows).
 *
 *   dotenv -e .env -- npx tsx scripts/seed-askmoji-fixtures.ts
 *   SEED_CLASSROOM_SLUG=some-other-class dotenv -e .env -- npx tsx scripts/seed-askmoji-fixtures.ts
 */
import { createHash } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';

const { indexOneFile } = ClassmojiService.contentIndex;

// Where /test-login lands by default.
const CLASSROOM_SLUG = process.env.SEED_CLASSROOM_SLUG || 'classmoji-dev-winter-2025';

type Fixture = {
  title: string;
  slug: string;
  is_draft: boolean;
  paragraphs: string[];
};

const FIXTURES: Fixture[] = [
  {
    title: 'Course Schedule',
    slug: 'course-schedule',
    is_draft: false,
    paragraphs: [
      'Welcome to the course. This page lists every important date for the term.',
      'Exam 2, which is the midterm, is scheduled for Thursday, October 22 at 10:10 AM in Room 105. Bring a calculator and one page of handwritten notes.',
      'Lab 3 is due Friday, October 9 at 11:59 PM. Late work loses ten percent per day.',
      'The final project showcase is on the last day of class.',
    ],
  },
  {
    title: 'Midterm Solutions',
    slug: 'midterm-solutions',
    is_draft: true,
    paragraphs: [
      'Staff notes for Exam 2, the midterm. This page stays a draft until grades are posted.',
      'Question 1: the answer is 42, because the recurrence collapses after the second step.',
      'Question 2: graders should look for the rubric code PURPLE-GIRAFFE-7 in the justification.',
    ],
  },
];

function blocknote(paragraphs: string[]): string {
  return JSON.stringify({
    blocks: paragraphs.map((text, i) => ({
      id: `p${i + 1}`,
      type: 'paragraph',
      props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
      content: [{ type: 'text', text, styles: {} }],
      children: [],
    })),
  });
}

async function main() {
  const prisma = getPrisma();

  const classroom = await prisma.classroom.findFirst({
    where: { slug: CLASSROOM_SLUG },
    select: { id: true, name: true },
  });
  if (!classroom) throw new Error(`No classroom with slug "${CLASSROOM_SLUG}" — run npm run db:seed first`);

  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroom.id, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!owner) throw new Error(`Classroom "${CLASSROOM_SLUG}" has no OWNER membership`);

  console.log(`seeding ${classroom.name} (${classroom.id})`);

  for (const f of FIXTURES) {
    const contentPath = `pages/${f.slug}`;
    const filePath = `${contentPath}/content.json`;
    const body = blocknote(f.paragraphs);
    const sha = createHash('sha1').update(body).digest('hex');

    await prisma.page.deleteMany({ where: { classroom_id: classroom.id, slug: f.slug } });

    const page = await prisma.page.create({
      data: {
        classroom_id: classroom.id,
        title: f.title,
        slug: f.slug,
        content_path: contentPath,
        created_by: owner.user_id,
        is_draft: f.is_draft,
        is_public: false,
        show_in_student_menu: !f.is_draft,
      },
    });

    // The indexer's superseded-sha guard reads the asset map for this path.
    await prisma.contentAsset.upsert({
      where: { classroom_id_path: { classroom_id: classroom.id, path: filePath } },
      create: {
        classroom_id: classroom.id,
        path: filePath,
        sha,
        type: 'blob',
        size: Buffer.byteLength(body),
        synced_at: new Date(),
      },
      update: { sha, size: Buffer.byteLength(body), synced_at: new Date() },
    });

    const result = await indexOneFile({
      classroomId: classroom.id,
      path: filePath,
      sha,
      body,
      docHint: { kind: 'page', id: page.id, title: f.title },
    });

    const rows = await prisma.$queryRaw<Array<{ has_vec: boolean }>>`
      SELECT (embedding IS NOT NULL) AS has_vec
        FROM content_index
       WHERE classroom_id = ${classroom.id} AND doc_kind = 'page' AND doc_id = ${page.id}`;

    console.log(
      `${f.is_draft ? 'DRAFT    ' : 'PUBLISHED'} ${f.title.padEnd(20)} page=${page.id} ` +
        `index=${JSON.stringify(result)} rows=${rows.length} vectors=${rows.filter(r => r.has_vec).length}`
    );
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
