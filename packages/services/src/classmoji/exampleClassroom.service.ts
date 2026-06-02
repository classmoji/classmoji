/**
 * Provision a per-user "Example Course" sandbox.
 *
 * Creates a fully populated, GitHub-free classroom that the new user OWNS, so
 * the in-classroom onboarding tour has real-looking data to walk through. It
 * mirrors the dev seed (packages/database/scripts/seed.js) but:
 *  - is parameterized by the owner,
 *  - lives under a single shared mock GitOrganization whose
 *    `github_installation_id` is NULL, so GitHub-touching views (repositories,
 *    teams, repo-health, syllabus bot) short-circuit to clean empty states
 *    instead of attempting real API calls,
 *  - marks the classroom `is_example` (which is what auto-starts the tour), and
 *  - namespaces repository provider ids by owner login so they stay globally
 *    unique across every user's sandbox.
 *
 * Idempotent: if the user's example classroom already exists, it returns early.
 * Shared demo personas (TA + 3 students) are upserted once and reused across all
 * sandboxes; their memberships, repos, and grades are created per classroom.
 *
 * Atomic: every per-classroom write runs inside one interactive transaction, so
 * a mid-run failure rolls the whole sandbox back rather than leaving a partial
 * classroom that the idempotency check would later mistake for "already done".
 */

import getPrisma from '@classmoji/database';

const EXAMPLE_ORG = {
  provider: 'GITHUB' as const,
  provider_id: 'example-org',
  login: 'classmoji-examples',
};

const DEMO_PEOPLE = [
  { login: 'example-ta', name: 'Avery (TA)', email: 'ta@example.classmoji', provider_id: 'ex-10000001', role: 'ASSISTANT' as const },
  { login: 'example-student-1', name: 'Sam Rivera', email: 's1@example.classmoji', provider_id: 'ex-10000002', role: 'STUDENT' as const },
  { login: 'example-student-2', name: 'Priya Shah', email: 's2@example.classmoji', provider_id: 'ex-10000003', role: 'STUDENT' as const },
  { login: 'example-student-3', name: 'Diego Costa', email: 's3@example.classmoji', provider_id: 'ex-10000004', role: 'STUDENT' as const },
];

const EMOJI_SCALE = [
  { emoji: '🔴', grade: 50, description: 'Needs Work' },
  { emoji: '🟡', grade: 75, description: 'Getting There' },
  { emoji: '🟢', grade: 100, description: 'Great Work' },
  { emoji: '⭐', grade: 110, description: 'Outstanding' },
];

const LETTER_SCALE = [
  { letter_grade: 'A', min_grade: 90 },
  { letter_grade: 'B', min_grade: 80 },
  { letter_grade: 'C', min_grade: 70 },
  { letter_grade: 'D', min_grade: 60 },
  { letter_grade: 'F', min_grade: 0 },
];

export async function provisionExampleClassroom(params: {
  ownerUserId: string;
  ownerLogin: string;
}): Promise<{ id: string; slug: string } | null> {
  const { ownerUserId, ownerLogin } = params;
  const prisma = getPrisma();

  // Shared mock org. Leave github_installation_id NULL on purpose. It's idempotent
  // and shared across every sandbox, so it lives outside the per-classroom tx.
  const org = await prisma.gitOrganization.upsert({
    where: {
      provider_provider_id: { provider: EXAMPLE_ORG.provider, provider_id: EXAMPLE_ORG.provider_id },
    },
    update: {},
    create: { provider: EXAMPLE_ORG.provider, provider_id: EXAMPLE_ORG.provider_id, login: EXAMPLE_ORG.login },
  });

  const slug = `example-${ownerLogin}`.toLowerCase();

  // Idempotent: if this user's example classroom already exists, do nothing.
  const existing = await prisma.classroom.findUnique({
    where: { git_org_id_slug: { git_org_id: org.id, slug } },
    select: { id: true, slug: true },
  });
  if (existing) return existing;

  // Build the entire sandbox in ONE interactive transaction so it's all-or-
  // nothing: any failure rolls back every write, leaving no partial classroom to
  // strand a user in (and the idempotency check above stays accurate, so the next
  // signup retries from a clean slate). Timeout is raised for the ~30 sequential
  // writes; all of them go through `tx`, never `prisma`.
  return prisma.$transaction(
    async tx => {
      const classroom = await tx.classroom.create({
        data: {
          git_org_id: org.id,
          slug,
          name: 'Example Course',
          content_namespace: slug,
          is_example: true,
          settings: { create: { show_grades_to_students: true, quizzes_enabled: true } },
        },
      });

      // The real user holds BOTH roles in their sandbox: OWNER (to explore the
      // instructor side) and STUDENT (to explore the student side). The landing
      // shows one card per role, and the in-classroom tour adapts to whichever
      // view they open.
      await tx.classroomMembership.create({
        data: { classroom_id: classroom.id, user_id: ownerUserId, role: 'OWNER', has_accepted_invite: true },
      });
      await tx.classroomMembership.create({
        data: { classroom_id: classroom.id, user_id: ownerUserId, role: 'STUDENT', has_accepted_invite: true },
      });

      // Shared demo personas + their memberships in this classroom.
      let taUser: { id: string } | null = null;
      const studentUsers: { id: string; login: string }[] = [];
      for (const p of DEMO_PEOPLE) {
        const image = `https://github.com/identicons/${p.login}.png`;
        const user = await tx.user.upsert({
          where: { login: p.login },
          update: { image },
          create: {
            provider: 'GITHUB',
            provider_id: p.provider_id,
            login: p.login,
            name: p.name,
            email: p.email,
            image,
            school_id: 'example',
          },
        });
        await tx.classroomMembership.create({
          data: { classroom_id: classroom.id, user_id: user.id, role: p.role, has_accepted_invite: true },
        });
        if (p.role === 'ASSISTANT') taUser = user;
        else studentUsers.push({ id: user.id, login: p.login });
      }

      // Module + two assignments (Part 1 graded + released, Part 2 awaiting grading).
      const courseModule = await tx.module.create({
        data: {
          classroom_id: classroom.id,
          title: 'hello-world',
          template: 'classmoji-examples/hello-world-template',
          weight: 100,
          type: 'INDIVIDUAL',
          is_published: true,
        },
      });
      const primaryRepo = await tx.moduleRepo.create({
        data: {
          module_id: courseModule.id,
          name: 'classmoji-examples/hello-world-template',
          provider: 'GITHUB',
          position: 0,
        },
      });
      const assignment1 = await tx.assignment.create({
        data: { module_id: courseModule.id, module_repo_id: primaryRepo.id, title: 'Hello World Part 1', weight: 50, is_published: true, grades_released: true },
      });
      const assignment2 = await tx.assignment.create({
        data: { module_id: courseModule.id, module_repo_id: primaryRepo.id, title: 'Hello World Part 2', weight: 50, is_published: true, grades_released: false },
      });

      // Grade scales.
      for (const m of EMOJI_SCALE) {
        await tx.emojiMapping.create({ data: { classroom_id: classroom.id, ...m, extra_tokens: 0 } });
      }
      for (const lg of LETTER_SCALE) {
        await tx.letterGradeMapping.create({ data: { classroom_id: classroom.id, ...lg } });
      }

      // Per-student repos, Part 1 grades + token gains, ungraded Part 2 for the queue.
      const gradeEmojis = ['🟢', '🟡', '🔴'];
      let firstRepoAssignment: { id: string } | null = null;
      for (let i = 0; i < studentUsers.length; i++) {
        const student = studentUsers[i];
        const emoji = gradeEmojis[i];
        const gradeValue = EMOJI_SCALE.find(m => m.emoji === emoji)?.grade ?? 0;

        const repo = await tx.repository.create({
          data: {
            classroom_id: classroom.id,
            module_id: courseModule.id,
            provider: 'GITHUB',
            provider_id: `example-repo-${ownerLogin}-${student.login}`,
            name: `${student.login}-hello-world`,
            student_id: student.id,
          },
        });
        const repoAssignment = await tx.repositoryAssignment.create({
          data: {
            repository_id: repo.id,
            assignment_id: assignment1.id,
            provider: 'GITHUB',
            provider_id: `example-issue-${ownerLogin}-${student.login}`,
            provider_issue_number: 100 + i,
            status: 'CLOSED',
          },
        });
        if (i === 0) firstRepoAssignment = repoAssignment;

        await tx.assignmentGrade.create({
          data: { repository_assignment_id: repoAssignment.id, grader_id: taUser?.id ?? null, emoji },
        });
        await tx.tokenTransaction.create({
          data: {
            classroom_id: classroom.id,
            student_id: student.id,
            repository_assignment_id: repoAssignment.id,
            amount: gradeValue,
            type: 'GAIN',
            balance_after: gradeValue,
          },
        });
        await tx.repositoryAssignment.create({
          data: {
            repository_id: repo.id,
            assignment_id: assignment2.id,
            provider: 'GITHUB',
            provider_id: `example-issue-p2-${ownerLogin}-${student.login}`,
            provider_issue_number: 200 + i,
            status: 'CLOSED',
          },
        });
      }

      // The owner's OWN student submissions, so their student-view dashboard,
      // assignments, grades, and tokens are populated (graded Part 1 + open Part 2).
      const selfRepo = await tx.repository.create({
        data: {
          classroom_id: classroom.id,
          module_id: courseModule.id,
          provider: 'GITHUB',
          provider_id: `example-repo-${ownerLogin}-self`,
          name: `${ownerLogin}-hello-world`,
          student_id: ownerUserId,
        },
      });
      const selfPart1 = await tx.repositoryAssignment.create({
        data: {
          repository_id: selfRepo.id,
          assignment_id: assignment1.id,
          provider: 'GITHUB',
          provider_id: `example-issue-${ownerLogin}-self`,
          provider_issue_number: 110,
          status: 'CLOSED',
        },
      });
      await tx.assignmentGrade.create({
        data: { repository_assignment_id: selfPart1.id, grader_id: taUser?.id ?? null, emoji: '⭐' },
      });
      await tx.tokenTransaction.create({
        data: {
          classroom_id: classroom.id,
          student_id: ownerUserId,
          repository_assignment_id: selfPart1.id,
          amount: 110,
          type: 'GAIN',
          balance_after: 110,
        },
      });
      await tx.repositoryAssignment.create({
        data: {
          repository_id: selfRepo.id,
          assignment_id: assignment2.id,
          provider: 'GITHUB',
          provider_id: `example-issue-p2-${ownerLogin}-self`,
          provider_issue_number: 210,
          status: 'CLOSED',
        },
      });

      // A few calendar events over the coming days.
      const calendarDefs = [
        { title: 'Week 1 Lecture', event_type: 'LECTURE' as const, offsetDays: 1, location: 'Room 101' },
        { title: 'Week 1 Lab', event_type: 'LAB' as const, offsetDays: 2, location: 'Room 101' },
        { title: 'TA Office Hours', event_type: 'OFFICE_HOURS' as const, offsetDays: 3, location: 'Online' },
      ];
      for (const ev of calendarDefs) {
        const start = new Date(Date.now() + ev.offsetDays * 24 * 60 * 60 * 1000);
        start.setHours(10, 0, 0, 0);
        const end = new Date(start.getTime() + 90 * 60 * 1000);
        await tx.calendarEvent.create({
          data: {
            classroom_id: classroom.id,
            title: ev.title,
            event_type: ev.event_type,
            start_time: start,
            end_time: end,
            created_by: taUser?.id ?? ownerUserId,
            location: ev.location,
          },
        });
      }

      // One pending regrade request from the lowest-graded student.
      if (firstRepoAssignment && studentUsers[0]) {
        await tx.regradeRequest.create({
          data: {
            repository_assignment_id: firstRepoAssignment.id,
            classroom_id: classroom.id,
            student_id: studentUsers[0].id,
            status: 'IN_REVIEW',
            student_comment: 'I believe my solution deserves a higher grade.',
            previous_grade: ['🔴'],
          },
        });
      }

      return { id: classroom.id, slug: classroom.slug };
    },
    { maxWait: 10000, timeout: 30000 }
  );
}
