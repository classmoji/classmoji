/**
 * What a student reads when joining a Github classroom fails, and what the
 * audit row keeps of Github's own answer.
 */

import { describe, expect, it } from 'vitest';
import { describeInviteFailure } from '../inviteError.server';

const ORG = 'cs52-fall';

/** The shape Octokit's RequestError carries. */
const githubError = (status: number, message: string, errors?: unknown[]) =>
  Object.assign(new Error(message), {
    status,
    response: { data: { message, ...(errors ? { errors } : {}) } },
  });

describe('describeInviteFailure', () => {
  it('names the daily invitation limit', () => {
    const failure = describeInviteFailure(
      githubError(422, 'Validation Failed', [{ message: 'Over invitation rate limit' }]),
      ORG
    );
    expect(failure.status).toBe(422);
    expect(failure.githubMessage).toBe('Validation Failed: Over invitation rate limit');
    expect(failure.message).toMatch(/daily limit on invitations/);
    expect(failure.message).toContain(ORG);
  });

  it('tells an existing org member to accept again', () => {
    const failure = describeInviteFailure(
      githubError(422, 'Validation Failed', [
        { message: 'Invitee is already a part of this organization' },
      ]),
      ORG
    );
    expect(failure.message).toMatch(/already in cs52-fall/);
  });

  it('points a student with a pending invite at Github', () => {
    const failure = describeInviteFailure(
      githubError(422, 'Validation Failed', ['Invitee has already been invited']),
      ORG
    );
    expect(failure.message).toContain(`github.com/orgs/${ORG}/invitation`);
  });

  it('reads a 429 or a rate-limit 403 as a wait', () => {
    expect(describeInviteFailure(githubError(429, 'Too Many Requests'), ORG).message).toMatch(
      /few minutes/
    );
    expect(
      describeInviteFailure(githubError(403, 'You have exceeded a secondary rate limit'), ORG)
        .message
    ).toMatch(/few minutes/);
  });

  it('sends permission and auth problems to the instructor', () => {
    expect(
      describeInviteFailure(githubError(403, 'Resource not accessible by integration'), ORG).message
    ).toMatch(/permissions/);
    expect(describeInviteFailure(githubError(401, 'Bad credentials'), ORG).message).toMatch(
      /reinstall/
    );
  });

  it('explains a 404', () => {
    expect(describeInviteFailure(githubError(404, 'Not Found'), ORG).message).toMatch(
      /could not find your account/
    );
  });

  it("falls back to Github's own words, then to a generic line", () => {
    const known = describeInviteFailure(githubError(500, 'Server Error'), ORG);
    expect(known.message).toBe('Could not send your Github invite: Server Error');

    const bare = describeInviteFailure('boom', ORG);
    expect(bare).toEqual({
      status: null,
      githubMessage: null,
      message: 'Could not send your Github invite. Try again, or ask your instructor.',
    });
  });

  it('caps a long Github message', () => {
    const failure = describeInviteFailure(githubError(500, 'x'.repeat(500)), ORG);
    expect(failure.githubMessage?.length).toBeLessThanOrEqual(201);
  });
});
