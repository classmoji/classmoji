import { PrismaClient } from '@prisma/client';

/**
 * Seed the Playwright E2E test user (prof-classmoji) for offline auth.
 *
 * The main dev seed (seed.js) intentionally defers prof-classmoji creation to
 * "first GitHub login". That requires a VALID GitHub token. For E2E we instead
 * pre-create the user + a `github` account row carrying the local token, so the
 * /test-login route's DB-first lookup succeeds and never calls the GitHub API.
 *
 * Each Playwright role gets its own identity and token, so a single account row
 * per user covers the roles that user holds.
 *
 * Run:  npx dotenv -e .env -- node packages/database/scripts/seed-test-user.js
 */
const prisma = new PrismaClient();

const TEST_CLASSROOM = process.env.TEST_CLASSROOM || 'classmoji-dev-winter-2025';

/**
 * One row per Playwright auth role. Each maps a (login, github id, token) to a
 * SINGLE classroom role so role-based access/denial tests are meaningful:
 *   - owner      = prof-classmoji  → OWNER (full instructor)
 *   - teacher    = fake-teacher    → TEACHER only   (NON-owner)
 *   - assistant  = fake-ta         → ASSISTANT only (NON-owner)
 *   - student    = fake-student-1  → STUDENT only   (NON-owner)
 * Distinct tokens make /test-login's DB-first lookup resolve to distinct users.
 */
const ROLES = [
  {
    login: process.env.TEST_USER_LOGIN || 'prof-classmoji',
    githubId: process.env.TEST_USER_ID || '220514774',
    token: process.env.GITHUB_PROF_TOKEN,
    name: 'Professor',
    email: 'prof.classmoji@gmail.com',
    roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
  },
  {
    login: process.env.TEST_TA_USER_LOGIN || 'fake-ta',
    githubId: process.env.TEST_TA_USER_ID || '10000001',
    token: process.env.GITHUB_TA_TOKEN,
    name: 'Dev TA',
    email: 'ta@dev.local',
    roles: ['ASSISTANT'],
  },
  {
    // Matches the fake-teacher identity seeded by seed.js (provider_id
    // 10000005). TEACHER is its own authz tier, so this user holds that role
    // and nothing else — a second membership here would make every
    // "denied for a teacher" assertion pass vacuously.
    login: process.env.TEST_TEACHER_USER_LOGIN || 'fake-teacher',
    githubId: process.env.TEST_TEACHER_USER_ID || '10000005',
    token: process.env.GITHUB_INSTRUCTOR_TOKEN,
    name: 'Dev Teacher',
    email: 'teacher@dev.local',
    roles: ['TEACHER'],
  },
  {
    login: process.env.TEST_STUDENT_USER_LOGIN || 'fake-student-1',
    githubId: process.env.TEST_STUDENT_USER_ID || '10000002',
    token: process.env.GITHUB_STUDENT_TOKEN,
    name: 'Dev Student 1',
    email: 'student1@dev.local',
    roles: ['STUDENT'],
  },
];

async function main() {
  const classroom = await prisma.classroom.findFirst({
    where: { slug: TEST_CLASSROOM },
    orderBy: { created_at: 'asc' }, // deterministic if a duplicate slug ever exists
  });
  if (!classroom) {
    throw new Error(
      `Classroom "${TEST_CLASSROOM}" not found. Run \`npm run db:seed\` first to create it.`
    );
  }

  for (const r of ROLES) {
    if (!r.token) throw new Error(`Missing token for ${r.login} (set its GITHUB_*_TOKEN in .env).`);

    const user = await prisma.user.upsert({
      where: { login: r.login },
      update: { provider: 'GITHUB', provider_id: r.githubId, emailVerified: true },
      create: {
        provider: 'GITHUB',
        provider_id: r.githubId,
        login: r.login,
        name: r.name,
        email: r.email,
        emailVerified: true,
        image: `https://github.com/identicons/${r.login}.png`,
        school_id: 'dev',
      },
    });

    // GitHub account carries the token for DB-first /test-login lookup (skips GitHub API).
    await prisma.account.upsert({
      where: { provider_id_account_id: { provider_id: 'github', account_id: r.githubId } },
      update: { access_token: r.token, user_id: user.id },
      create: { user_id: user.id, provider_id: 'github', account_id: r.githubId, access_token: r.token },
    });

    for (const role of r.roles) {
      await prisma.classroomMembership.upsert({
        where: {
          classroom_id_user_id_role: { classroom_id: classroom.id, user_id: user.id, role },
        },
        update: { has_accepted_invite: true },
        create: { classroom_id: classroom.id, user_id: user.id, role, has_accepted_invite: true },
      });
    }

    console.log(`✅ ${r.login} (github ${r.githubId}) → ${r.roles.join('+')}`);
  }

  console.log(`   Classroom: ${classroom.slug} (${classroom.id}) — tokens stored, /test-login skips GitHub API.`);
}

main()
  .catch(e => {
    console.error('❌ seed-test-user failed:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
