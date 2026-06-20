// Dev-only helper to enable authenticated screenshots without real Github OAuth.
// Creates: a dummy OWNER user + membership, an in-DB session per role (owner/ta/student)
// whose token can be injected as the `classmoji.session_token` cookie, and a couple of
// modules so the Modules pages have content. Idempotent. Safe to re-run; remove the
// rows by re-running `npm run db:seed` (sessions) or deleting the dev-owner user.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SLUG = 'classmoji-dev-winter-2025';

async function main() {
  const classroom = await prisma.classroom.findFirst({ where: { slug: SLUG } });
  if (!classroom) throw new Error(`Classroom ${SLUG} not found — run npm run db:seed first`);

  // Keep student nav at its defaults (Modules nav off for students; the Owner
  // always sees Modules to build them). show_pages/show_repos stay on.
  await prisma.classroomSettings.update({
    where: { classroom_id: classroom.id },
    data: { show_modules: false, show_pages: true, show_repos: true },
  });

  // ── Dummy OWNER ───────────────────────────────────────────────────────────
  const owner = await prisma.user.upsert({
    where: { login: 'dev-owner' },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: '10000000',
      login: 'dev-owner',
      name: 'Dev Owner',
      email: 'owner@dev.local',
      image: 'https://github.com/identicons/dev-owner.png',
      school_id: 'dev',
    },
  });
  await prisma.classroomMembership.upsert({
    where: {
      classroom_id_user_id_role: {
        classroom_id: classroom.id,
        user_id: owner.id,
        role: 'OWNER',
      },
    },
    update: {},
    create: {
      classroom_id: classroom.id,
      user_id: owner.id,
      role: 'OWNER',
      has_accepted_invite: true,
    },
  });

  const ta = await prisma.user.findFirst({ where: { login: 'fake-ta' } });
  const student = await prisma.user.findFirst({ where: { login: 'fake-student-1' } });

  // ── Sessions (token = cookie value) ───────────────────────────────────────
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const sessions = [
    { token: 'devshot-owner', user_id: owner.id },
    { token: 'devshot-ta', user_id: ta.id },
    { token: 'devshot-student', user_id: student.id },
  ];
  for (const s of sessions) {
    await prisma.session.upsert({
      where: { token: s.token },
      update: { expires_at: expires },
      create: {
        token: s.token,
        user_id: s.user_id,
        expires_at: expires,
        ip_address: '127.0.0.1',
        user_agent: 'dev-screenshot',
      },
    });
  }

  // ── Modules ───────────────────────────────────────────────────────────────
  const repo = await prisma.repository.findFirst({
    where: { classroom_id: classroom.id, title: 'hello-world' },
  });

  const week1 = await prisma.module.upsert({
    where: { classroom_id_title: { classroom_id: classroom.id, title: 'Week 1: Getting Started' } },
    update: { is_published: true },
    create: {
      classroom_id: classroom.id,
      title: 'Week 1: Getting Started',
      slug: 'week-1-getting-started',
      description: 'Set up your environment and ship your first program.',
      position: 0,
      is_published: true,
    },
  });
  if (repo) {
    const existingItem = await prisma.moduleItem.findFirst({
      where: { module_id: week1.id, repository_id: repo.id },
    });
    if (!existingItem) {
      await prisma.moduleItem.create({
        data: {
          module_id: week1.id,
          item_type: 'REPOSITORY',
          repository_id: repo.id,
          position: 0,
        },
      });
    }
  }

  await prisma.module.upsert({
    where: { classroom_id_title: { classroom_id: classroom.id, title: 'Week 2: Arrays & Lists' } },
    update: {},
    create: {
      classroom_id: classroom.id,
      title: 'Week 2: Arrays & Lists',
      slug: 'week-2-arrays-lists',
      description: 'Core data structures and how to reason about them.',
      position: 1,
      is_published: false,
    },
  });

  console.log('✅ Screenshot setup complete');
  console.log(`   Classroom slug: ${SLUG}`);
  console.log('   Cookies (classmoji.session_token):');
  console.log('     owner   -> devshot-owner');
  console.log('     ta      -> devshot-ta');
  console.log('     student -> devshot-student');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1); // eslint-disable-line no-process-exit
  });
