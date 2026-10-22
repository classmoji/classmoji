/**
 * The staff email for a new regrade request (TA_REGRADE_ASSIGNED), rendered
 * through the `notification` template. A quiz request goes to the
 * classroom's owners and teachers (a quiz has no assigned graders), so it
 * names the quiz and, when the notice carries it, the attempt, and does not
 * say "assigned to you". Neither kind repeats the in-app title's "Regrade
 * request: " prefix, and no grade appears.
 */
import { describe, expect, it } from 'vitest';
import { renderEmail } from '../notificationEmails.ts';

const base = {
  type: 'TA_REGRADE_ASSIGNED' as const,
  classroomName: 'CS 52',
  resourceType: 'regrade_request',
  resourceId: 'rr-1',
  recipientName: 'Prof',
};

describe('TA_REGRADE_ASSIGNED email', () => {
  it('names a repo request without the in-app prefix', () => {
    const { variables } = renderEmail({
      ...base,
      title: 'Regrade request: Lab 1 - lab-1-ada',
    }).template;
    expect(variables.MESSAGE_TEXT).toBe(
      'Hi Prof,\n\nA regrade request for Lab 1 - lab-1-ada in CS 52 has been assigned to you.'
    );
    expect(variables.SUBJECT).toBe('[Classmoji] CS 52 - New regrade request');
  });

  it('names a quiz request by its quiz and attempt, escaped, and not as assigned', () => {
    const { variables } = renderEmail({
      ...base,
      title: 'Regrade request: Week 3 quiz',
      metadata: { target: 'quiz', quiz_name: 'Week <3> quiz', attempt_number: 2 },
    }).template;
    expect(variables.MESSAGE_TEXT).toBe(
      'Hi Prof,\n\nA student asked for a regrade of Week <3> quiz (attempt 2) in CS 52.'
    );
    expect(variables.MESSAGE_HTML).toContain('Week &lt;3&gt; quiz (attempt 2)');
    expect(variables.MESSAGE_HTML).not.toContain('assigned to you');
  });

  it('falls back to the title for a quiz notice that carries no quiz name', () => {
    const { variables } = renderEmail({
      ...base,
      title: 'Regrade request: Week 3 quiz',
      metadata: { target: 'quiz' },
    }).template;
    expect(variables.MESSAGE_TEXT).toContain(
      'A student asked for a regrade of Week 3 quiz in CS 52.'
    );
  });
});
