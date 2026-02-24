import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const fakeNumericId = () => String(Math.floor(Math.random() * 900000000) + 100000000);

async function main() {
  console.log('🌱 Seeding dev database...\n');

  // ── Fake GitOrganization ────────────────────────────────────────────────
  // github_installation_id must be non-null — create-classroom loader filters
  // gitOrganizations where { github_installation_id: { not: null } }
  const org = await prisma.gitOrganization.upsert({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: '80000000' } },
    update: {},
    create: {
      provider: 'GITHUB',
      provider_id: '80000000',
      login: 'dev-org',
      github_installation_id: fakeNumericId(),
    },
  });

  // ── Classroom ────────────────────────────────────────────────────────────
  // Slug must match TEST_CLASSROOM env var default in test-login route
  const classroom = await prisma.classroom.upsert({
    where: { slug: 'classmoji-dev-winter-2025' },
    update: {},
    create: {
      git_org_id: org.id,
      slug: 'classmoji-dev-winter-2025',
      name: 'Dev Classroom',
      term: 'WINTER',
      year: 2025,
    },
  });

  // ── ClassroomSettings ───────────────────────────────────────────────────
  await prisma.classroomSettings.upsert({
    where: { classroom_id: classroom.id },
    update: {},
    create: {
      classroom_id: classroom.id,
      show_grades_to_students: true,
      quizzes_enabled: true,
    },
  });

  // ── Fake Users + Memberships ────────────────────────────────────────────
  // Fully fake — no real GitHub IDs or tokens needed
  const fakeUsers = [
    {
      login: 'fake-ta',
      name: 'Dev TA',
      email: 'ta@dev.local',
      provider_id: fakeNumericId(),
      role: 'ASSISTANT',
    },
    {
      login: 'fake-student-1',
      name: 'Dev Student 1',
      email: 'student1@dev.local',
      provider_id: fakeNumericId(),
      role: 'STUDENT',
    },
    {
      login: 'fake-student-2',
      name: 'Dev Student 2',
      email: 'student2@dev.local',
      provider_id: fakeNumericId(),
      role: 'STUDENT',
    },
    {
      login: 'fake-student-3',
      name: 'Dev Student 3',
      email: 'student3@dev.local',
      provider_id: fakeNumericId(),
      role: 'STUDENT',
    },
  ].map(u => ({ ...u, image: `https://github.com/identicons/${u.login}.png` }));

  for (const u of fakeUsers) {
    const user = await prisma.user.upsert({
      where: { login: u.login },
      update: { image: u.image },
      create: {
        provider: 'GITHUB',
        provider_id: u.provider_id,
        login: u.login,
        name: u.name,
        email: u.email,
        image: u.image,
        school_id: 'dev',
      },
    });

    await prisma.classroomMembership.upsert({
      where: { classroom_id_user_id: { classroom_id: classroom.id, user_id: user.id } },
      update: {},
      create: {
        classroom_id: classroom.id,
        user_id: user.id,
        role: u.role,
        has_accepted_invite: true,
      },
    });
  }

  // ── Module + Assignments ────────────────────────────────────────────────
  const module = await prisma.module.upsert({
    where: { classroom_id_title: { classroom_id: classroom.id, title: 'hello-world' } },
    update: {},
    create: {
      classroom_id: classroom.id,
      title: 'hello-world',
      template: 'dev-org/hello-world-template',
      weight: 100,
      type: 'INDIVIDUAL',
      is_published: true,
    },
  });

  for (const title of ['Hello World Part 1', 'Hello World Part 2']) {
    await prisma.assignment.upsert({
      where: { module_id_title: { module_id: module.id, title } },
      update: {},
      create: {
        module_id: module.id,
        title,
        weight: 50,
        is_published: true,
      },
    });
  }

  console.log('✅ Dev seed complete!\n');
  console.log(`   Org:        ${org.login}`);
  console.log(`   Classroom:  ${classroom.name} (${classroom.slug})`);
  console.log(`   Fake users: 1 TA + 3 students`);
  console.log(`   Module:     hello-world (2 assignments)`);
  console.log(`\nSign in via GitHub OAuth to auto-join as OWNER.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
