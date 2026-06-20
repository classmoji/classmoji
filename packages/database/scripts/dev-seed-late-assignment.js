// Dev-only: add one late, OPEN assignment to the hello-world repo so the student
// token-extension flow can be exercised. Deadline is 5h in the past, 5 tokens/hour.
// Idempotent. Re-run `npm run db:seed` to reset base data.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SLUG = 'classmoji-dev-winter-2025';

async function main() {
  const classroom = await prisma.classroom.findFirst({ where: { slug: SLUG } });
  if (!classroom) throw new Error(`Classroom ${SLUG} not found — run npm run db:seed first`);

  const repository = await prisma.repository.findFirst({
    where: { classroom_id: classroom.id, title: 'hello-world' },
  });
  if (!repository) throw new Error('hello-world repository not found — run npm run db:seed first');

  const deadline = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago

  const assignment = await prisma.assignment.upsert({
    where: { repository_id_title: { repository_id: repository.id, title: 'Late Lab' } },
    update: { student_deadline: deadline, tokens_per_hour: 5 },
    create: {
      repository_id: repository.id,
      title: 'Late Lab',
      weight: 50,
      is_published: true,
      grades_released: false,
      student_deadline: deadline,
      tokens_per_hour: 5,
    },
  });

  // One OPEN GitRepoAssignment per student repo so each student is "late".
  const studentRepos = await prisma.gitRepo.findMany({
    where: { classroom_id: classroom.id, repository_id: repository.id, student_id: { not: null } },
  });

  let i = 0;
  for (const gitRepo of studentRepos) {
    await prisma.gitRepoAssignment.upsert({
      where: {
        provider_provider_id: { provider: 'GITHUB', provider_id: `fake-issue-late-${gitRepo.id}` },
      },
      update: { status: 'OPEN' },
      create: {
        git_repo_id: gitRepo.id,
        assignment_id: assignment.id,
        provider: 'GITHUB',
        provider_id: `fake-issue-late-${gitRepo.id}`,
        provider_issue_number: 300 + i,
        status: 'OPEN',
      },
    });
    i++;
  }

  console.log(`✅ Late assignment "Late Lab" added (deadline 5h ago, 5 tokens/hour)`);
  console.log(`   OPEN submissions for ${studentRepos.length} student repo(s)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1); // eslint-disable-line no-process-exit
  });
