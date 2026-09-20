/**
 * The calendar write policy, as a table.
 *
 * It is enforced in three places — the admin calendar action, the assistant
 * calendar action and the MCP calendar tools — so it lives in one
 * dependency-free module and is pinned once, here. Each of those three has its
 * own test that it ASKS this; what the answer should be is settled below.
 */

import { describe, it, expect } from 'vitest';
import {
  ASSISTANT_EVENT_TYPE,
  ASSISTANT_EVENT_TYPE_MESSAGE,
  assistantMayChangeEventType,
  assistantMayCreateEventType,
  CalendarTimeRangeError,
  isCalendarTimeRangeError,
  isFeaturedLinkRow,
  resolveFeaturedLink,
  type FeaturedLinkRef,
} from '../calendarPolicy.ts';

describe('what an assistant may create', () => {
  it('allows office hours and nothing else', () => {
    expect(assistantMayCreateEventType('OFFICE_HOURS')).toBe(true);
    for (const type of ['LECTURE', 'LAB', 'ASSESSMENT']) {
      expect(assistantMayCreateEventType(type)).toBe(false);
    }
  });

  it('refuses a create that names no type at all', () => {
    // Create requires one, so a missing type is a malformed request, not an
    // "unchanged" one — the update rule below is where absence means no change.
    expect(assistantMayCreateEventType(undefined)).toBe(false);
    expect(assistantMayCreateEventType(null)).toBe(false);
  });
});

describe('what an assistant may change an event to', () => {
  it('refuses moving an office-hours event to another type', () => {
    // The whole point: without this, the create limit is worth nothing — add
    // office hours, then retype it as a lecture.
    expect(assistantMayChangeEventType('LECTURE', 'OFFICE_HOURS')).toBe(false);
    expect(assistantMayChangeEventType('LAB', 'OFFICE_HOURS')).toBe(false);
    expect(assistantMayChangeEventType('ASSESSMENT', 'OFFICE_HOURS')).toBe(false);
  });

  it('allows an update that does not mention the type', () => {
    expect(assistantMayChangeEventType(undefined, 'OFFICE_HOURS')).toBe(true);
    expect(assistantMayChangeEventType(null, 'LECTURE')).toBe(true);
  });

  it('allows re-sending the type the event already has', () => {
    // An edit form posts every field. If somebody else retyped the event, the
    // assistant must still be able to change its time or place — refusing that
    // is a wall they can neither understand nor get around.
    expect(assistantMayChangeEventType('LECTURE', 'LECTURE')).toBe(true);
  });

  it('allows moving an event TOWARDS office hours', () => {
    expect(assistantMayChangeEventType('OFFICE_HOURS', 'LECTURE')).toBe(true);
  });

  it('names the one type in a constant both halves share', () => {
    expect(ASSISTANT_EVENT_TYPE).toBe('OFFICE_HOURS');
    expect(ASSISTANT_EVENT_TYPE_MESSAGE).toMatch(/office hours/i);
  });
});

describe('which linked resource gets the star', () => {
  const VALIDATED = {
    pageIds: ['page-a', 'page-b'],
    slideIds: ['deck-a'],
    assignmentIds: ['hw-a'],
  };

  const cases: Array<[string, FeaturedLinkRef | null | undefined, FeaturedLinkRef | null]> = [
    ['a page that is being linked', { kind: 'page', id: 'page-b' }, { kind: 'page', id: 'page-b' }],
    ['a deck that is being linked', { kind: 'slide', id: 'deck-a' }, { kind: 'slide', id: 'deck-a' }],
    [
      'an assignment that is being linked',
      { kind: 'assignment', id: 'hw-a' },
      { kind: 'assignment', id: 'hw-a' },
    ],
    // Not a refusal: the save keeps its links and simply shows nothing under
    // the event. An id can fail to be in the list because the user unlinked it
    // in the same save, or because the caller already dropped it as belonging
    // to another classroom.
    ['an id nobody is linking', { kind: 'page', id: 'page-elsewhere' }, null],
    // The kind is what the caller asserted; honouring an id found under
    // another kind would star a row the user did not point at.
    ['a page id offered as a deck', { kind: 'slide', id: 'page-a' }, null],
    ['no star at all', null, null],
    ['an absent star', undefined, null],
    ['an empty id', { kind: 'page', id: '' }, null],
    ['a kind the calendar does not have', { kind: 'quiz' as 'page', id: 'page-a' }, null],
  ];

  it.each(cases)('resolves %s', (_name, featured, expected) => {
    expect(resolveFeaturedLink(featured, VALIDATED)).toEqual(expected);
  });

  it('is asked per row, so exactly one row can come out true', () => {
    const resolved = resolveFeaturedLink({ kind: 'page', id: 'page-b' }, VALIDATED);

    expect(VALIDATED.pageIds.map(id => isFeaturedLinkRow(resolved, 'page', id))).toEqual([
      false,
      true,
    ]);
    // Same id, another kind's table: still not the starred row.
    expect(isFeaturedLinkRow(resolved, 'slide', 'page-b')).toBe(false);
    expect(isFeaturedLinkRow(resolved, 'assignment', 'hw-a')).toBe(false);
  });

  it('stars nothing when nothing resolved', () => {
    expect(isFeaturedLinkRow(null, 'page', 'page-a')).toBe(false);
  });
});

describe('recognising a refused time range', () => {
  it('accepts the error the service throws', () => {
    expect(isCalendarTimeRangeError(new CalendarTimeRangeError())).toBe(true);
  });

  it('accepts one that crossed a module boundary and lost its identity', () => {
    // A bundler that splits this package, or a mocked import, hands a caller a
    // structurally identical error that fails `instanceof`. The discriminant is
    // what survives.
    expect(isCalendarTimeRangeError({ reason: 'end_before_start', message: 'x' })).toBe(true);
  });

  it('rejects anything else, so a real fault is not shown as a form error', () => {
    expect(isCalendarTimeRangeError(new Error('connection reset'))).toBe(false);
    expect(isCalendarTimeRangeError({ reason: 'something_else' })).toBe(false);
    expect(isCalendarTimeRangeError(null)).toBe(false);
    expect(isCalendarTimeRangeError(undefined)).toBe(false);
    expect(isCalendarTimeRangeError('end_before_start')).toBe(false);
  });
});
