/** Teardown project for pro.setup.ts: removes the run's tagged PRO rows. */
import { test as teardown } from '@playwright/test';
import { removeTestPro } from './helpers/pro.helpers';

teardown('the test classroom is no longer Pro', async () => {
  await removeTestPro();
});
