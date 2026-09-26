// Dev-only: organize an imported classroom's repositories into a module, for the
// import doc's "modules" screenshot. Idempotent.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SLUG = 'cs-106a-programming-methodology-fall-2025';

async function main() {
  const classroom = await prisma.classroom.findFirst({ where: { slug: SLUG } });
  if (!classroom) throw new Error(`Classroom ${SLUG} not found — run the import first`);

  await prisma.classroomSettings.update({
    where: { classroom_id: classroom.id },
    data: { show_modules: true },
  });

  const repos = await prisma.repository.findMany({
    where: { classroom_id: classroom.id },
    orderBy: { created_at: 'asc' },
  });

  const week1 = await prisma.module.upsert({
    where: { classroom_id_title: { classroom_id: classroom.id, title: 'Week 1: Getting Started' } },
    update: { is_published: true },
    create: {
      classroom_id: classroom.id,
      title: 'Week 1: Getting Started',
      slug: 'week-1-getting-started',
      description: 'Your first two assignments, imported from Github Classroom.',
      position: 0,
      is_published: true,
    },
  });

  for (const repo of repos) {
    // Re-home every assignment of these repositories under Week 1. Their
    // migration-synthesized modules stay behind empty, which is fine for a
    // dev screenshot.
    await prisma.assignment.updateMany({
      where: { repository_id: repo.id },
      data: { module_id: week1.id },
    });
  }

  console.log(
    `✅ Module "Week 1: Getting Started" created with ${repos.length} imported repo item(s); show_modules enabled`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1); // eslint-disable-line no-process-exit
  });
