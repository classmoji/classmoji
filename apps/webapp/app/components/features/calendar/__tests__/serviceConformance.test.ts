/**
 * Type-level conformance between what the calendar service returns and what the
 * client components expect.
 *
 * The client types (`~/components/features/calendar/types`) are deliberately
 * hand-written rather than derived from `@classmoji/services`: importing a
 * service type into a component would pull the whole service graph — Prisma
 * included — into the browser bundle. That freedom is also the risk, so this
 * file pins the places where the two shapes must agree.
 *
 * It lives in a TEST file, not in a component: every import below is
 * `import type`, so nothing here reaches the bundle.
 *
 * WHAT ACTUALLY CHECKS IT: `npm run typecheck` — `tsc --noEmit` over `app/**`,
 * which this file is inside. That is the SOLE gate. `expectTypeOf` is a
 * compile-time construct: vitest collects this file and runs the `it` bodies,
 * but at runtime the assertions do nothing, so a green `web:test:unit` says
 * nothing about them.
 *
 * Vitest CAN check them, via `test.typecheck` over `.test-d.ts` files. That was
 * tried and rejected: vitest's typechecker runs tsc over the whole project, so
 * it reports the pre-existing, unrelated `useGitProvider` error in
 * `RequireGitProvider.tsx` as an unhandled error and fails `web:test:unit`,
 * and it takes the suite from ~8s to ~29s. Reconsider once that error is gone.
 *
 * Only relationships that are TRUE today are asserted. Where the shapes do not
 * line up yet, the gap is named in a comment rather than papered over.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { ClassroomCalendarItem } from '@classmoji/services';
import type { CalendarEventWithLinks } from '../types';

/** A real CalendarEvent occurrence (recurring or not). */
type ExpandedItem = Exclude<ClassroomCalendarItem, { is_deadline: true }>;

/** A synthesized item: an assignment deadline or a form close. */
type SyntheticItem = Extract<ClassroomCalendarItem, { is_deadline: true }>;

describe('calendar service → client event shape', () => {
  it('delivers times the client type accepts', () => {
    // This is what `start_time: string | Date` on the client type is for: the
    // service types these as Date and single fetch delivers real Dates, while
    // an optimistic client update writes an ISO string back over them.
    expectTypeOf<ExpandedItem['start_time']>().toExtend<CalendarEventWithLinks['start_time']>();
    expectTypeOf<ExpandedItem['end_time']>().toExtend<CalendarEventWithLinks['end_time']>();
    expectTypeOf<SyntheticItem['start_time']>().toExtend<CalendarEventWithLinks['start_time']>();
    expectTypeOf<SyntheticItem['end_time']>().toExtend<CalendarEventWithLinks['end_time']>();
  });

  it('delivers an occurrence date the client type accepts', () => {
    // Same story: a Date, not a string — which is why `occurrence_date` is
    // widened too. Every consumer runs it through `new Date(…)` or `dayjs(…)`.
    expectTypeOf<ExpandedItem['occurrence_date']>().toExtend<
      CalendarEventWithLinks['occurrence_date']
    >();
  });

  it('delivers synthesized deadline/form-close fields the client type accepts', () => {
    expectTypeOf<SyntheticItem['id']>().toExtend<CalendarEventWithLinks['id']>();
    expectTypeOf<SyntheticItem['title']>().toExtend<CalendarEventWithLinks['title']>();
    expectTypeOf<SyntheticItem['event_type']>().toExtend<CalendarEventWithLinks['event_type']>();
    expectTypeOf<SyntheticItem['is_deadline']>().toExtend<CalendarEventWithLinks['is_deadline']>();
    expectTypeOf<SyntheticItem['is_unpublished']>().toExtend<
      CalendarEventWithLinks['is_unpublished']
    >();
    expectTypeOf<SyntheticItem['github_issue_url']>().toExtend<
      CalendarEventWithLinks['github_issue_url']
    >();
  });

  it('delivers raw link rows whose occurrence dates the client type accepts', () => {
    // The edit modal filters `_raw*Links` by occurrence date, so that field has
    // to line up. The rest of the raw row does NOT line up yet: the service's
    // link interfaces declare `page`/`slide`/`assignment` but not the
    // `page_id`/`slide_id`/`assignment_id` columns the modal actually reads, so
    // whole-row assignability cannot be asserted until the service builds its
    // display payload explicitly.
    // Each kind is compared against ITS OWN client type — the three raw-link
    // types are separate declarations, so checking all three against the page's
    // would pass even if the slide or assignment one drifted.
    type OccurrenceOf<T> = T extends { occurrence_date?: infer O } ? O : never;

    expectTypeOf<OccurrenceOf<NonNullable<ExpandedItem['_rawPageLinks']>[number]>>().toExtend<
      OccurrenceOf<NonNullable<CalendarEventWithLinks['_rawPageLinks']>[number]>
    >();
    expectTypeOf<OccurrenceOf<NonNullable<ExpandedItem['_rawSlideLinks']>[number]>>().toExtend<
      OccurrenceOf<NonNullable<CalendarEventWithLinks['_rawSlideLinks']>[number]>
    >();
    expectTypeOf<OccurrenceOf<NonNullable<ExpandedItem['_rawAssignmentLinks']>[number]>>().toExtend<
      OccurrenceOf<NonNullable<CalendarEventWithLinks['_rawAssignmentLinks']>[number]>
    >();
  });

  it('delivers linked page/slide rows whose non-null form the client type accepts', () => {
    // The service types these entries with a NULLABLE `page`/`slide` (the
    // Prisma include allows it); the client type does not model that, because
    // a link row without its target is not rendered. Assert the non-null form.
    type ServicePage = NonNullable<NonNullable<ExpandedItem['pages']>[number]['page']>;
    expectTypeOf<ServicePage>().toExtend<
      NonNullable<CalendarEventWithLinks['pages']>[number]['page']
    >();

    type ServiceSlide = NonNullable<NonNullable<ExpandedItem['slides']>[number]['slide']>;
    expectTypeOf<ServiceSlide>().toExtend<
      NonNullable<CalendarEventWithLinks['slides']>[number]['slide']
    >();
  });
});
