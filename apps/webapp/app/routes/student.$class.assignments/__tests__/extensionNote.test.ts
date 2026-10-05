/**
 * The note under a row's date once a student has bought extension hours. The
 * date stays the assignment's deadline; the note says how many hours were
 * applied and whether the student is (still) late.
 */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { extensionNote } from '../extensionNote';

const DEADLINE = '2026-10-01T17:00:00';
const base = {
  deadline: DEADLINE,
  done: false,
  extensionHours: 24,
  numLateHours: 0,
  isLateOverride: false,
  closedAt: null,
};

describe('extensionNote', () => {
  it('is absent with no hours bought, no deadline, or a late override', () => {
    expect(extensionNote({ ...base, extensionHours: 0 })).toBeNull();
    expect(extensionNote({ ...base, deadline: null })).toBeNull();
    expect(extensionNote({ ...base, isLateOverride: true })).toBeNull();
  });

  it('bought ahead of the deadline: says until when the student is not late', () => {
    const note = extensionNote(base, dayjs('2026-10-01T09:00:00'));
    expect(note).toEqual({
      text: '+24h applied · not late until Oct 2, 5:00 PM',
      tone: 'info',
      inWindow: false,
    });
  });

  it('past the deadline but inside the hours bought: in the window, so not overdue', () => {
    const note = extensionNote(base, dayjs('2026-10-02T10:00:00'));
    expect(note?.inWindow).toBe(true);
    expect(note?.text).toBe('+24h applied · not late until Oct 2, 5:00 PM');
  });

  it('past the hours bought and still unsubmitted: says how late', () => {
    const note = extensionNote({ ...base, numLateHours: 3 }, dayjs('2026-10-02T20:00:00'));
    expect(note).toEqual({ text: '+24h applied · 3h still late', tone: 'info', inWindow: false });
  });

  it('past the hours bought with nothing submitted to be late by (a missing quiz): the hours only', () => {
    const note = extensionNote({ ...base, numLateHours: 0 }, dayjs('2026-10-02T20:00:00'));
    expect(note).toEqual({ text: '+24h applied', tone: 'info', inWindow: false });
  });

  it('a late submission the hours covered: no longer late', () => {
    const note = extensionNote({
      ...base,
      done: true,
      extensionHours: 5,
      closedAt: '2026-10-01T22:10:00',
    });
    expect(note).toEqual({
      text: '+5h applied · no longer late 🎉',
      tone: 'good',
      inWindow: false,
    });
  });

  it('a late submission the hours did not cover: says how late it still is', () => {
    const note = extensionNote({
      ...base,
      done: true,
      extensionHours: 2,
      numLateHours: 3,
      closedAt: '2026-10-01T22:10:00',
    });
    expect(note?.text).toBe('+2h applied · 3h still late');
  });

  it('an on-time submission with hours bought: just the hours applied', () => {
    const note = extensionNote({ ...base, done: true, closedAt: '2026-10-01T12:00:00' });
    expect(note).toEqual({ text: '+24h applied', tone: 'info', inWindow: false });
  });
});
