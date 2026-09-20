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

/**
 * Every key of every variant. `keyof` over a union yields only the keys the
 * variants share, which would quietly skip most of what is being checked here.
 */
type KeysOf<T> = T extends unknown ? keyof T : never;

/** Every key any calendar item can arrive with. */
type ServiceKeys = KeysOf<ClassroomCalendarItem>;

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

  it('delivers whole raw link rows the client type accepts', () => {
    // The edit modal reads both columns of a raw row — which resource, and
    // which occurrence it is attached to — so the WHOLE row has to line up, not
    // just the date. Each kind is compared against ITS OWN client type: the
    // three raw-link types are separate declarations, so checking all three
    // against the page's would pass even if the slide or assignment one
    // drifted.
    expectTypeOf<NonNullable<ExpandedItem['_rawPageLinks']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['_rawPageLinks']>[number]
    >();
    expectTypeOf<NonNullable<ExpandedItem['_rawSlideLinks']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['_rawSlideLinks']>[number]
    >();
    expectTypeOf<NonNullable<ExpandedItem['_rawAssignmentLinks']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['_rawAssignmentLinks']>[number]
    >();
  });

  it('delivers linked page/slide/assignment rows the client type accepts', () => {
    expectTypeOf<NonNullable<ExpandedItem['pages']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['pages']>[number]
    >();
    expectTypeOf<NonNullable<ExpandedItem['slides']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['slides']>[number]
    >();
    // Carries `is_published` on both the assignment and its repository: the
    // link list marks one the class cannot see yet.
    expectTypeOf<NonNullable<ExpandedItem['assignments']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['assignments']>[number]
    >();
  });

  it('delivers a deadline’s linked pages and decks in the same shape', () => {
    // The deadline leg builds its own arrays; they render through the same
    // component, so they answer to the same client type — including the
    // `is_draft` flag the Draft treatment reads.
    expectTypeOf<NonNullable<SyntheticItem['pages']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['pages']>[number]
    >();
    expectTypeOf<NonNullable<SyntheticItem['slides']>[number]>().toExtend<
      NonNullable<CalendarEventWithLinks['slides']>[number]
    >();
  });

  it('delivers the creator id the staff routes gate editing on', () => {
    expectTypeOf<ExpandedItem['created_by']>().toExtend<CalendarEventWithLinks['created_by']>();
  });

  it('delivers a starred resource the month view can draw, on EVERY kind of item', () => {
    // The synthetic items answer `null` rather than leaving the key off:
    // neither carries an index signature, so a grid reading
    // `featured_resource` across the union needs it declared on every variant.
    expectTypeOf<ExpandedItem['featured_resource']>().toExtend<
      CalendarEventWithLinks['featured_resource']
    >();
    expectTypeOf<SyntheticItem['featured_resource']>().toEqualTypeOf<null>();
  });
});

describe('client event shape → calendar service', () => {
  it('names nothing the service never sends', () => {
    // The other direction: a client field the service has no key for is a field
    // that is always undefined at runtime — a rename, or a component reading
    // something nobody decided to send. Neither shows up in the checks above,
    // because they all start from a service key.
    expectTypeOf<Exclude<keyof CalendarEventWithLinks, ServiceKeys>>().toEqualTypeOf<never>();
  });

  it('is the only shape the payload carries — no stored link relations ride along', () => {
    // The calendar builds its display payload key by key. The stored relations
    // (`pageLinks`/`slideLinks`/`assignmentLinks`) and the override rows are
    // inputs to that build, not part of its result: linked content leaves as
    // the occurrence-filtered, visibility-filtered display arrays.
    expectTypeOf<
      Extract<ServiceKeys, 'pageLinks' | 'slideLinks' | 'assignmentLinks' | 'overrides'>
    >().toEqualTypeOf<never>();
  });
});
