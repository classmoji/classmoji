#!/usr/bin/env node
/**
 * Recreate Page and Slide DB rows from a content GitHub repo.
 *
 * Walks `pages/*` and `slides/*` in the configured repo and inserts rows
 * pointing at each existing content directory. Idempotent: skips rows that
 * already exist (by content_path for pages, by slug for slides).
 *
 * Usage:
 *   node scripts/import-content-from-github.js
 *
 * Env: DATABASE_URL (required), GITHUB_TOKEN (optional, only needed for
 *      private repos or to avoid unauthenticated rate limits).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const CLASSROOM_SLUG = 'classmoji-dev-winter-2025';
const REPO_OWNER = 'classmoji-development';
const REPO_NAME = 'content-classmoji-development-25w';
const TERM_STRING = '25w';

const prisma = new PrismaClient();

async function ghList(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} ${url}`);
  }
  return res.json();
}

function humanize(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

async function uniqueTitle(classroomId, base) {
  let title = base;
  let n = 0;
  while (
    await prisma.page.findFirst({
      where: { classroom_id: classroomId, title },
      select: { id: true },
    })
  ) {
    n += 1;
    title = `${base} (${n})`;
  }
  return title;
}

async function main() {
  const classroom = await prisma.classroom.findUnique({
    where: { slug: CLASSROOM_SLUG },
    select: { id: true, term: true, year: true },
  });
  if (!classroom) {
    throw new Error(`Classroom "${CLASSROOM_SLUG}" not found`);
  }

  const ownerMembership = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroom.id, role: 'OWNER' },
    select: { user_id: true },
  });
  if (!ownerMembership) {
    throw new Error(`No OWNER membership found for classroom ${classroom.id}`);
  }
  const userId = ownerMembership.user_id;

  console.log(
    `Importing into classroom=${classroom.id} owner=${userId} repo=${REPO_OWNER}/${REPO_NAME}`
  );

  // Pages
  const pageDirs = (await ghList('pages')).filter((e) => e.type === 'dir');
  console.log(`\nFound ${pageDirs.length} page directories in repo`);

  let pageCreated = 0;
  let pageSkipped = 0;
  for (const dir of pageDirs) {
    const slug = dir.name;
    const contentPath = `pages/${slug}`;

    const existing = await prisma.page.findFirst({
      where: { classroom_id: classroom.id, content_path: contentPath },
      select: { id: true, title: true },
    });
    if (existing) {
      console.log(`  SKIP page ${slug} (exists: ${existing.id} "${existing.title}")`);
      pageSkipped += 1;
      continue;
    }

    const title = await uniqueTitle(classroom.id, humanize(slug));
    const created = await prisma.page.create({
      data: {
        classroom_id: classroom.id,
        title,
        slug,
        content_path: contentPath,
        created_by: userId,
        is_draft: false,
        is_public: true,
      },
      select: { id: true },
    });
    console.log(`  CREATE page ${slug} → ${created.id} "${title}"`);
    pageCreated += 1;
  }

  // Slides
  const slideDirs = (await ghList('slides')).filter((e) => e.type === 'dir');
  console.log(`\nFound ${slideDirs.length} slide directories in repo`);

  let slideCreated = 0;
  let slideSkipped = 0;
  for (const dir of slideDirs) {
    const slug = dir.name;
    const contentPath = `slides/${slug}`;

    const existing = await prisma.slide.findFirst({
      where: { classroom_id: classroom.id, slug },
      select: { id: true, title: true },
    });
    if (existing) {
      console.log(`  SKIP slide ${slug} (exists: ${existing.id} "${existing.title}")`);
      slideSkipped += 1;
      continue;
    }

    const title = humanize(slug);
    const created = await prisma.slide.create({
      data: {
        classroom_id: classroom.id,
        title,
        slug,
        term: TERM_STRING,
        content_path: contentPath,
        created_by: userId,
        is_draft: false,
        is_public: true,
      },
      select: { id: true },
    });
    console.log(`  CREATE slide ${slug} → ${created.id} "${title}"`);
    slideCreated += 1;
  }

  console.log(
    `\nDone. pages: ${pageCreated} created, ${pageSkipped} skipped. slides: ${slideCreated} created, ${slideSkipped} skipped.`
  );
}

main()
  .then(() => prisma.$disconnect().then(() => process.exit(0)))
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
