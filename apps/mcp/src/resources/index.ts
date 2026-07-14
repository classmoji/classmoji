/**
 * Resource manifest (plan §7 read surface). Registration order is listing
 * order. Idempotent so both the server entrypoint and tests may call it.
 *
 * NOTE on template matching: the SDK matches resource templates in
 * registration order with fully-anchored regexes, so
 * `…/regrade-requests` never swallows `…/regrade-requests/mine` and
 * `…/calendar` never swallows `…/calendar/{start}/{end}`.
 */

import { registerResourceDefinition } from '../mcp/registry.ts';
import { classroomInfoResource } from './classroomInfo.ts';
import {
  calendarRangeResource,
  calendarResource,
  modulesResource,
  pagesResource,
  quizzesResource,
} from './content.ts';
import {
  gradingQueueResource,
  leaderboardResource,
  regradeMineResource,
  regradeQueueResource,
  submissionResource,
} from './grading.ts';
import { meResource } from './me.ts';
import { gradesMineResource, reposResource } from './repos.ts';
import { rosterResource, teamsResource } from './roster.ts';
import { tokensResource } from './tokens.ts';

let registered = false;

export function registerAllResources(): void {
  if (registered) return;
  registered = true;

  registerResourceDefinition(meResource);
  registerResourceDefinition(classroomInfoResource);
  registerResourceDefinition(rosterResource);
  registerResourceDefinition(teamsResource);
  registerResourceDefinition(reposResource);
  registerResourceDefinition(gradesMineResource);
  registerResourceDefinition(leaderboardResource);
  registerResourceDefinition(gradingQueueResource);
  registerResourceDefinition(submissionResource);
  registerResourceDefinition(regradeQueueResource);
  registerResourceDefinition(regradeMineResource);
  registerResourceDefinition(quizzesResource);
  registerResourceDefinition(pagesResource);
  registerResourceDefinition(modulesResource);
  registerResourceDefinition(calendarResource);
  registerResourceDefinition(calendarRangeResource);
  registerResourceDefinition(tokensResource);
}
