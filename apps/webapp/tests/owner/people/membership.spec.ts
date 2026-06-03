import { test, expect } from '../../fixtures/auth.fixture';
import { getTestPrisma, getClassroomBySlug } from '../../helpers/prisma.helpers';
import { TEST_CLASSROOM } from '../../helpers/env.helpers';
import { waitForDataLoad } from '../../helpers/wait.helpers';

const ASSISTANTS_PATH = (org: string) => `/admin/${org}/assistants`;

// Stable login so cleanup/upsert always target the same throwaway assistant user.
const TA = {
  login: 'qa-grader-ta-people-membership',
  name: 'Marvin Android QA',
};

async function seedAssistant(opts: { isGrader: boolean }) {
  const prisma = getTestPrisma();
  const classroom = await getClassroomBySlug(TEST_CLASSROOM);

  const user = await prisma.user.upsert({
    where: { login: TA.login },
    create: {
      login: TA.login,
      name: TA.name,
      provider: 'GITHUB',
      provider_id: `qa-${TA.login}`,
      role: 'user',
      email: `${TA.login}@grader-qa.test`,
    },
    update: { name: TA.name },
    select: { id: true },
  });

  await prisma.classroomMembership.upsert({
    where: {
      classroom_id_user_id_role: {
        classroom_id: classroom.id,
        user_id: user.id,
        role: 'ASSISTANT',
      },
    },
    create: {
      classroom_id: classroom.id,
      user_id: user.id,
      role: 'ASSISTANT',
      is_grader: opts.isGrader,
      has_accepted_invite: true,
    },
    update: { is_grader: opts.isGrader, has_accepted_invite: true },
  });

  return { classroomId: classroom.id, userId: user.id };
}

async function cleanupAssistant() {
  const prisma = getTestPrisma();
  const user = await prisma.user.findUnique({ where: { login: TA.login }, select: { id: true } });
  if (!user) return;
  await prisma.classroomMembership.deleteMany({ where: { user_id: user.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
}

async function readIsGrader(classroomId: string, userId: string): Promise<boolean | null> {
  const prisma = getTestPrisma();
  const row = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroomId, user_id: userId, role: 'ASSISTANT' },
    select: { is_grader: true },
  });
  return row ? row.is_grader : null;
}

test.describe('Owner changes a teaching-team member role', () => {
  test.afterEach(async () => {
    await cleanupAssistant();
  });

  test("owner promotes an assistant to grader and the membership's is_grader flips to true in the DB", async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const { classroomId, userId } = await seedAssistant({ isGrader: false });
    expect(await readIsGrader(classroomId, userId)).toBe(false);

    await page.goto(ASSISTANTS_PATH(testOrg));
    await waitForDataLoad(page);

    const row = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: TA.name });
    await expect(row).toBeVisible();
    await row.getByRole('radio', { name: 'Yes' }).check();

    await expect
      .poll(async () => readIsGrader(classroomId, userId), { timeout: 15000 })
      .toBe(true);
  });

  test("owner demotes a grader and the membership's is_grader flips to false in the DB", async ({
    authenticatedPage: page,
    testOrg,
  }) => {
    const { classroomId, userId } = await seedAssistant({ isGrader: true });
    expect(await readIsGrader(classroomId, userId)).toBe(true);

    await page.goto(ASSISTANTS_PATH(testOrg));
    await waitForDataLoad(page);

    const row = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: TA.name });
    await expect(row).toBeVisible();
    await row.getByRole('radio', { name: 'No' }).check();

    await expect
      .poll(async () => readIsGrader(classroomId, userId), { timeout: 15000 })
      .toBe(false);
  });
});

test.describe('Owner promotes a student to TA', () => {
  // known issue: no in-app control promotes a STUDENT membership to ASSISTANT.
  test.fixme(
    true,
    'MISSING: no in-app control promotes an existing STUDENT membership to ASSISTANT (role is never mutated by the people UI); the assistants form creates a new membership via live GitHub instead'
  );
});

test.describe('Owner removes a classroom member', () => {
  // known issue: member removal runs in the remove_user_from_organization task; no worker/org in CI.
  test.fixme(
    true,
    'MISSING: member removal delegates to the remove_user_from_organization Trigger.dev task (GitHub org + membership delete happen in the task, not the action); no worker/org in CI so the membership delete cannot be asserted'
  );
});
