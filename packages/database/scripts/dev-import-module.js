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

  let pos = 0;
  for (const repo of repos) {
    const existing = await prisma.moduleItem.findFirst({
      where: { module_id: week1.id, repository_id: repo.id },
    });
    if (!existing) {
      await prisma.moduleItem.create({
        data: { module_id: week1.id, item_type: 'REPOSITORY', repository_id: repo.id, position: pos },
      });
    }
    pos++;
  }

  console.log(`✅ Module "Week 1: Getting Started" created with ${repos.length} imported repo item(s); show_modules enabled`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async e => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1); // eslint-disable-line no-process-exit
  });
