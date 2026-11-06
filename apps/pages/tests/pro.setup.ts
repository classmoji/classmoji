/**
 * Setup and teardown projects for the e2e run: the test classroom is Pro.
 *
 * Forms' staff screens (assertFormAdmin → assertProTier) need Pro, and Pro
 * follows the classroom owners' subscriptions, which the dev seed does not
 * create. Every accepted OWNER of the test classroom gets a PRO row tagged for
 * this suite; the teardown project removes exactly those rows, and a run killed
 * before teardown is cleared by the next setup. Specs that need a FREE
 * classroom still add a newer FREE row of their own (forms-copy-link.spec.ts).
 *
 * Only the `pages-e2e` project depends on this (playwright.config.ts), so the
 * pure `tests/unit` specs never need a database.
 */
import { test as setup } from '@playwright/test';
import { getTestPrisma } from './helpers/prisma.helpers';
import { getTestClassroomSlug } from './helpers/env.helpers';
import { removeTestPro, TEST_PRO_TAG } from './helpers/pro.helpers';

setup('the test classroom is Pro', async () => {
  const prisma = await getTestPrisma();
  await removeTestPro();

  const slug = getTestClassroomSlug();
  const owners = await prisma.classroomMembership.findMany({
    where: { classroom: { slug }, role: 'OWNER', has_accepted_invite: true },
    select: { user_id: true },
  });
  if (owners.length === 0) {
    throw new Error(
      `${slug} has no accepted OWNER — is the dev DB seeded? (seed.js, then seed-test-user.js)`
    );
  }
  // stripe_subscription_id is unique, so each row carries its owner's id.
  await prisma.subscription.createMany({
    data: owners.map(o => ({
      user_id: o.user_id,
      tier: 'PRO' as const,
      stripe_subscription_id: `${TEST_PRO_TAG}-${o.user_id}`,
    })),
  });
});
