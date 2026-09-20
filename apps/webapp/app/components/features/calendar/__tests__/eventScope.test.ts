/**
 * The two rules the edit modal turns on when a recurring event is edited.
 *
 * Both are pure functions in their own module precisely so they can be asserted
 * here: the modal that uses them needs a DOM, antd and a form instance, and
 * none of that makes these rules any clearer.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScopedEventData,
  EDIT_SCOPES,
  filterLinksForOccurrence,
  isExpandedOccurrence,
  scopeCarriesLinks,
} from '../eventScope';

const BASE = { title: 'Lecture 3', start_time: '2026-09-21T14:00:00.000Z' };
const LINKS = {
  linkedPageIds: ['p-1'],
  linkedSlideIds: ['s-1'],
  linkedAssignmentIds: ['a-1'],
};
const OCCURRENCE = '2026-09-21T00:00:00.000Z';

describe('which edit scopes carry resource links', () => {
  it('sends the link ids with an edit scoped to this occurrence', () => {
    const submitted = buildScopedEventData(BASE, EDIT_SCOPES.THIS_ONLY, OCCURRENCE, LINKS);

    expect(submitted).toMatchObject({
      ...BASE,
      ...LINKS,
      editScope: 'this_only',
      occurrenceDate: OCCURRENCE,
    });
  });

  it.each([EDIT_SCOPES.ALL, EDIT_SCOPES.THIS_AND_FUTURE])(
    'sends NO link ids with a %s edit',
    scope => {
      // Not "sends empty arrays": the action keys its link write off whether
      // the keys are present at all, so an empty array would still clear every
      // date's links. The keys have to be absent.
      const submitted = buildScopedEventData(BASE, scope, OCCURRENCE, LINKS) as Record<
        string,
        unknown
      >;

      expect('linkedPageIds' in submitted).toBe(false);
      expect('linkedSlideIds' in submitted).toBe(false);
      expect('linkedAssignmentIds' in submitted).toBe(false);
      expect(submitted.editScope).toBe(scope);
      // The rest of the edit still goes through.
      expect(submitted.title).toBe('Lecture 3');
    }
  );

  it('says so directly, for anything else that has to make the same call', () => {
    expect(scopeCarriesLinks(EDIT_SCOPES.THIS_ONLY)).toBe(true);
    expect(scopeCarriesLinks(EDIT_SCOPES.ALL)).toBe(false);
    expect(scopeCarriesLinks(EDIT_SCOPES.THIS_AND_FUTURE)).toBe(false);
  });
});

describe('which stored links prefill the pickers', () => {
  const links = [
    { page_id: 'p-this', occurrence_date: '2026-09-21T00:00:00.000Z' },
    { page_id: 'p-other', occurrence_date: '2026-09-28T00:00:00.000Z' },
    { page_id: 'p-undated', occurrence_date: null },
  ];

  it('takes only this occurrence’s links for a recurring event', () => {
    // The undated one predates the event becoming recurring; the calendar does
    // not display it, so the pickers must not offer to re-save it.
    const kept = filterLinksForOccurrence(links, OCCURRENCE, true);

    expect(kept.map(l => l.page_id)).toEqual(['p-this']);
  });

  it('keeps the undated links for an event that does not recur', () => {
    const kept = filterLinksForOccurrence(links, OCCURRENCE, false);

    expect(kept.map(l => l.page_id)).toEqual(['p-this', 'p-undated']);
  });

  it('accepts a Date as readily as an ISO string, and no links at all', () => {
    expect(
      filterLinksForOccurrence(
        [{ page_id: 'p-this', occurrence_date: new Date('2026-09-21T00:00:00.000Z') }],
        new Date('2026-09-21T23:00:00.000Z'),
        true
      )
    ).toHaveLength(1);
    expect(filterLinksForOccurrence(undefined, OCCURRENCE, true)).toEqual([]);
  });
});

describe('which items count as an expanded occurrence', () => {
  it('reads the occurrence date, not the recurring flag', () => {
    expect(isExpandedOccurrence({ occurrence_date: '2026-09-21T00:00:00.000Z' })).toBe(true);
    expect(isExpandedOccurrence({ occurrence_date: new Date('2026-09-21') })).toBe(true);
    expect(isExpandedOccurrence({ occurrence_date: null })).toBe(false);
    expect(isExpandedOccurrence({})).toBe(false);
  });

  it('keeps the undated links of an event flagged recurring with no days', () => {
    // The row that made this worth extracting: `is_recurring` is true, but the
    // rule names no days, so the calendar cannot expand it — it shows the event
    // once, off its own date, reading the undated links. Keying the picker off
    // the flag would hide them, and saving would then delete them.
    const dayless = {
      is_recurring: true,
      recurrence_rule: { days: [] },
      occurrence_date: null,
      start_time: '2026-09-21T14:00:00.000Z',
    };
    const links = [
      { page_id: 'p-undated', occurrence_date: null },
      { page_id: 'p-dated', occurrence_date: '2026-09-28T00:00:00.000Z' },
    ];

    const kept = filterLinksForOccurrence(
      links,
      dayless.occurrence_date || dayless.start_time,
      isExpandedOccurrence(dayless)
    );

    expect(kept.map(l => l.page_id)).toEqual(['p-undated']);
  });
});
