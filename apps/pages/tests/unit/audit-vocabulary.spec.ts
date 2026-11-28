/**
 * The pages app's audit rows are named in the audit vocabulary: the funnel's
 * `resource_type` is `AuditResourceType`, and the forms and team-set
 * constants are names in it. The type assertion is checked by `tsc`.
 */
import { test, expect } from '@playwright/test';
import {
  isAuditResourceType,
  type AuditResourceType,
} from '@classmoji/services/audit-resource-types';

import type { PagesAuditRow } from '../../app/utils/audit.server.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const funnelTakesTheVocabulary: Equal<PagesAuditRow['resource_type'], AuditResourceType> = true;

test('the pages funnel names rows in the audit vocabulary', () => {
  expect(funnelTakesTheVocabulary).toBe(true);
  for (const name of ['PAGES', 'FORMS', 'TEAM_SETS']) expect(isAuditResourceType(name)).toBe(true);
});
