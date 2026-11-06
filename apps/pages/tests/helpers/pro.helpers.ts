import { getTestPrisma } from './prisma.helpers';

/** The tag on the PRO rows the e2e run gives the test classroom's owners. */
export const TEST_PRO_TAG = 'pages-e2e-pro';

/** Remove every PRO row an e2e run (this one or a killed earlier one) added. */
export async function removeTestPro(): Promise<void> {
  const prisma = await getTestPrisma();
  await prisma.subscription.deleteMany({
    where: { stripe_subscription_id: { startsWith: TEST_PRO_TAG } },
  });
}
