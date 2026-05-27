import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
      github_installation_id: '80000001',
    },
  });

  // ── Classroom ────────────────────────────────────────────────────────────
  // Slug must match TEST_CLASSROOM env var default in test-login route
  const classroom = await prisma.classroom.upsert({
    where: { git_org_id_slug: { git_org_id: org.id, slug: 'classmoji-dev-winter-2025' } },
    update: {},
    create: {
      git_org_id: org.id,
      slug: 'classmoji-dev-winter-2025',
      name: 'Dev Classroom',
      content_namespace: 'classmoji-dev-winter-2025',
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
  // provider_ids are stable so re-runs don't create duplicate records
  const fakeUsers = [
    {
      login: 'fake-ta',
      name: 'Dev TA',
      email: 'ta@dev.local',
      provider_id: '10000001',
      role: 'ASSISTANT',
    },
    {
      login: 'fake-student-1',
      name: 'Dev Student 1',
      email: 'student1@dev.local',
      provider_id: '10000002',
      role: 'STUDENT',
    },
    {
      login: 'fake-student-2',
      name: 'Dev Student 2',
      email: 'student2@dev.local',
      provider_id: '10000003',
      role: 'STUDENT',
    },
    {
      login: 'fake-student-3',
      name: 'Dev Student 3',
      email: 'student3@dev.local',
      provider_id: '10000004',
      role: 'STUDENT',
    },
  ].map(u => ({ ...u, image: `https://github.com/identicons/${u.login}.png` }));

  let taUser = null;
  const studentUsers = [];

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
      where: {
        classroom_id_user_id_role: { classroom_id: classroom.id, user_id: user.id, role: u.role },
      },
      update: {},
      create: {
        classroom_id: classroom.id,
        user_id: user.id,
        role: u.role,
        has_accepted_invite: true,
      },
    });

    if (u.role === 'ASSISTANT') taUser = user;
    if (u.role === 'STUDENT') studentUsers.push(user);
  }

  // ── Repository + Assignments ────────────────────────────────────────────
  const repository = await prisma.repository.upsert({
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

  const assignments = [];
  for (const [i, title] of ['Hello World Part 1', 'Hello World Part 2'].entries()) {
    const a = await prisma.assignment.upsert({
      where: { repository_id_title: { repository_id: repository.id, title } },
      update: { grades_released: i === 0 }, // Part 1 grades visible to students
      create: {
        repository_id: repository.id,
        title,
        weight: 50,
        is_published: true,
        grades_released: i === 0,
      },
    });
    assignments.push(a);
  }
  const [assignment1, assignment2] = assignments;

  // ── Emoji Grade Scale ───────────────────────────────────────────────────
  const emojiMappings = [
    { emoji: '🔴', grade: 50, description: 'Needs Work' },
    { emoji: '🟡', grade: 75, description: 'Getting There' },
    { emoji: '🟢', grade: 100, description: 'Great Work' },
    { emoji: '⭐', grade: 110, description: 'Outstanding' },
  ];
  for (const m of emojiMappings) {
    await prisma.emojiMapping.upsert({
      where: { classroom_id_emoji: { classroom_id: classroom.id, emoji: m.emoji } },
      update: {},
      create: { classroom_id: classroom.id, ...m, extra_tokens: 0 },
    });
  }

  // ── Letter Grade Scale ──────────────────────────────────────────────────
  const letterGrades = [
    { letter_grade: 'A', min_grade: 90 },
    { letter_grade: 'B', min_grade: 80 },
    { letter_grade: 'C', min_grade: 70 },
    { letter_grade: 'D', min_grade: 60 },
    { letter_grade: 'F', min_grade: 0 },
  ];
  for (const lg of letterGrades) {
    await prisma.letterGradeMapping.upsert({
      where: {
        classroom_id_letter_grade: { classroom_id: classroom.id, letter_grade: lg.letter_grade },
      },
      update: {},
      create: { classroom_id: classroom.id, ...lg },
    });
  }

  // ── GitRepos + Grades + Token Transactions ──────────────────────────────
  // Grade each student on Part 1 with different emojis
  const gradeEmojis = ['🟢', '🟡', '🔴'];
  let firstGitRepoAssignment = null;

  for (let i = 0; i < studentUsers.length; i++) {
    const student = studentUsers[i];
    const emoji = gradeEmojis[i];
    const gradeValue = emojiMappings.find(m => m.emoji === emoji).grade;

    const gitRepo = await prisma.gitRepo.upsert({
      where: {
        provider_provider_id: { provider: 'GITHUB', provider_id: `fake-repo-${student.login}` },
      },
      update: {},
      create: {
        classroom_id: classroom.id,
        repository_id: repository.id,
        provider: 'GITHUB',
        provider_id: `fake-repo-${student.login}`,
        name: `${student.login}-hello-world`,
        student_id: student.id,
      },
    });

    const gitRepoAssignment = await prisma.gitRepoAssignment.upsert({
      where: {
        provider_provider_id: { provider: 'GITHUB', provider_id: `fake-issue-${student.login}` },
      },
      update: {},
      create: {
        git_repo_id: gitRepo.id,
        assignment_id: assignment1.id,
        provider: 'GITHUB',
        provider_id: `fake-issue-${student.login}`,
        provider_issue_number: 100 + i,
        status: 'CLOSED',
      },
    });

    if (i === 0) firstGitRepoAssignment = gitRepoAssignment;

    const existingGrade = await prisma.assignmentGrade.findFirst({
      where: { git_repo_assignment_id: gitRepoAssignment.id },
    });
    if (!existingGrade) {
      await prisma.assignmentGrade.create({
        data: {
          git_repo_assignment_id: gitRepoAssignment.id,
          grader_id: taUser.id,
          emoji,
        },
      });
      await prisma.tokenTransaction.create({
        data: {
          classroom_id: classroom.id,
          student_id: student.id,
          git_repo_assignment_id: gitRepoAssignment.id,
          amount: gradeValue,
          type: 'GAIN',
          balance_after: gradeValue,
        },
      });
    }

    // Part 2: submitted but ungraded — fills the TA grading queue
    await prisma.gitRepoAssignment.upsert({
      where: {
        provider_provider_id: { provider: 'GITHUB', provider_id: `fake-issue-p2-${student.login}` },
      },
      update: {},
      create: {
        git_repo_id: gitRepo.id,
        assignment_id: assignment2.id,
        provider: 'GITHUB',
        provider_id: `fake-issue-p2-${student.login}`,
        provider_issue_number: 200 + i,
        status: 'CLOSED',
      },
    });
  }

  // ── Calendar Events ─────────────────────────────────────────────────────
  const calendarDefs = [
    { title: 'Week 1 Lecture', event_type: 'LECTURE', offsetDays: 1, location: 'Room 101' },
    { title: 'Week 1 Lab', event_type: 'LAB', offsetDays: 2, location: 'Room 101' },
    { title: 'TA Office Hours', event_type: 'OFFICE_HOURS', offsetDays: 3, location: 'Online' },
  ];
  for (const ev of calendarDefs) {
    const existing = await prisma.calendarEvent.findFirst({
      where: { classroom_id: classroom.id, title: ev.title },
    });
    if (!existing) {
      const start = new Date(Date.now() + ev.offsetDays * 24 * 60 * 60 * 1000);
      start.setHours(10, 0, 0, 0);
      const end = new Date(start.getTime() + 90 * 60 * 1000);
      await prisma.calendarEvent.create({
        data: {
          classroom_id: classroom.id,
          title: ev.title,
          event_type: ev.event_type,
          start_time: start,
          end_time: end,
          created_by: taUser.id,
          location: ev.location,
        },
      });
    }
  }

  // ── Regrade Request ─────────────────────────────────────────────────────
  // Student 1 (lowest grade 🔴) requests a regrade
  if (firstGitRepoAssignment) {
    const existingRegrade = await prisma.regradeRequest.findFirst({
      where: { git_repo_assignment_id: firstGitRepoAssignment.id },
    });
    if (!existingRegrade) {
      await prisma.regradeRequest.create({
        data: {
          git_repo_assignment_id: firstGitRepoAssignment.id,
          classroom_id: classroom.id,
          student_id: studentUsers[0].id,
          status: 'IN_REVIEW',
          student_comment: 'I believe my solution deserves a higher grade.',
          previous_grade: ['🔴'],
        },
      });
    }
  }

  console.log('✅ Dev seed complete!\n');
  console.log(`   Org:         ${org.login}`);
  console.log(`   Classroom:   ${classroom.name} (${classroom.slug})`);
  console.log(`   Fake users:  1 TA + 3 students`);
  console.log(`   Repository:  hello-world (2 assignments)`);
  console.log(`   Emoji scale: 🔴 🟡 🟢 ⭐`);
  console.log(`   Grades:      Part 1 graded — 🟢 🟡 🔴 (released)`);
  console.log(`   TA queue:    3 Part 2 submissions awaiting grading`);
  console.log(`   Calendar:    3 events (lecture, lab, office hours)`);
  console.log(`   Regrade:     1 pending request`);
  console.log(`\nSign in via GitHub OAuth → auto-join as OWNER + ASSISTANT + STUDENT.`);
  console.log(`Your student data (graded Part 1 + open Part 2) is created on first login.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1); // eslint-disable-line no-process-exit
  });
