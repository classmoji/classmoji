/**
 * The event modals' meeting-link field asks the same question the save does,
 * so a value the save would refuse is caught in the form, and a pasted
 * invitation — which the save turns into a link plus description text — is not.
 * An edit form's prefilled value passes unchanged, even when it holds no link.
 */

import { describe, expect, it } from 'vitest';
import { MEETING_LINK_MESSAGE } from '@classmoji/services/calendar-policy';
import { meetingLinkRule } from '../utils';

const validate = (value: unknown, stored?: string | null) =>
  meetingLinkRule(stored).validator({}, value);

describe('the meeting-link field rule', () => {
  it('accepts an empty field', async () => {
    await expect(validate(undefined)).resolves.toBeUndefined();
    await expect(validate('')).resolves.toBeUndefined();
  });

  it('accepts a link', async () => {
    await expect(validate('https://zoom.us/j/91234567890')).resolves.toBeUndefined();
  });

  it('accepts a pasted invitation that contains a link', async () => {
    await expect(
      validate('Join Zoom Meeting https://zoom.us/j/91234567890 Meeting ID: 912 3456 7890')
    ).resolves.toBeUndefined();
  });

  it('refuses text with no link, with the message the user sees', async () => {
    await expect(validate('Meeting ID: 912 3456 7890')).rejects.toThrow(MEETING_LINK_MESSAGE);
  });

  it('accepts the prefilled note unchanged', async () => {
    await expect(validate('See Canvas', 'See Canvas')).resolves.toBeUndefined();
  });

  it('refuses a changed note', async () => {
    await expect(validate('See Canvas p. 2', 'See Canvas')).rejects.toThrow(MEETING_LINK_MESSAGE);
  });
});
