/**
 * tokenErrors: describeTokenMintError, redactAccessTokens. Pure string
 * functions — no GitHub, no DB, nothing to stub.
 *
 * What these guard:
 *
 * - An import that cannot mint a token for an org must SAY WHICH ORG. The
 *   incident these came from showed a bare "Failed to retrieve GitHub
 *   installation token (404)" in the progress banner, which named neither the
 *   org nor the real cause (an installation id belonging to a different
 *   environment's GitHub App).
 * - A git failure must never carry an installation token into `ImportJob.error`,
 *   which is persisted and rendered to the user. Git echoes the remote URL —
 *   credentials included — in its own error output.
 */

import { describe, it, expect } from 'vitest';
import { describeTokenMintError, redactAccessTokens } from '../tokenErrors.ts';

describe('describeTokenMintError', () => {
  it("names the org and the status from GitHubProvider's own error message", () => {
    // The exact shape GitHubProvider.getAccessToken throws: a plain Error whose
    // only record of the status is the trailing "(404)".
    const message = describeTokenMintError(
      'dartmouth-cs52',
      new Error('Failed to retrieve GitHub installation token (404)')
    );

    expect(message).toContain("'dartmouth-cs52'");
    expect(message).toContain('(404)');
    expect(message).toContain("this environment's GitHub App may not be installed on that org");
  });

  it('prefers a structured status over anything in the message', () => {
    const octokitError = Object.assign(new Error('Not Found'), { status: 401 });
    expect(describeTokenMintError('brown-cs32', octokitError)).toContain('(401)');
  });

  it('reads the status off a response object', () => {
    const error = Object.assign(new Error('Not Found'), { response: { status: 403 } });
    expect(describeTokenMintError('brown-cs32', error)).toContain('(403)');
  });

  it('still explains itself when there is no status at all', () => {
    // A DNS/network failure rejects with a statusless TypeError.
    const message = describeTokenMintError('brown-cs32', new TypeError('fetch failed'));

    expect(message).toContain("'brown-cs32'");
    expect(message).toContain('fetch failed');
    expect(message).toContain("this environment's GitHub App may not be installed on that org");
  });

  it('handles a missing org login and a non-Error throw', () => {
    expect(describeTokenMintError(null, 'kaboom')).toContain("'unknown org'");
    expect(describeTokenMintError('cs52', undefined)).toContain("'cs52'");
  });

  it('never lets a token in a statusless message through', () => {
    const message = describeTokenMintError(
      'cs52',
      new Error('could not read https://x-access-token:ghs_aaaaaaaaaaaaaaaaaaaaaa@github.com/x.git')
    );
    expect(message).not.toContain('ghs_aaaaaaaaaaaaaaaaaaaaaa');
    expect(message).toContain('***');
  });

  it('bounds the detail so a huge dump cannot become the message', () => {
    const message = describeTokenMintError('cs52', new Error('x'.repeat(5000)));
    expect(message.length).toBeLessThan(400);
  });
});

describe('redactAccessTokens', () => {
  it("strips the credential from git's echoed remote URL", () => {
    const gitError =
      "fatal: repository 'https://x-access-token:ghs_16CharsMinimumAAAA@github.com/cs52/content-cs52.git/' not found";
    const redacted = redactAccessTokens(gitError);

    expect(redacted).not.toContain('ghs_16CharsMinimumAAAA');
    expect(redacted).toContain('https://x-access-token:***@github.com/cs52/content-cs52.git');
    // The useful half of the message survives.
    expect(redacted).toContain('not found');
  });

  it('strips bare token literals with no URL around them', () => {
    expect(redactAccessTokens('token ghp_abcdefghijklmnopqrstuvwxyz012345 expired')).toBe(
      'token *** expired'
    );
    expect(
      redactAccessTokens('using github_pat_11ABCDEFG0123456789_abcdefghijklmnop for auth')
    ).toBe('using *** for auth');
  });

  it('is idempotent — redacting redacted text changes nothing', () => {
    const once = redactAccessTokens(
      'https://x-access-token:ghs_16CharsMinimumAAAA@github.com/cs52/x.git'
    );
    expect(redactAccessTokens(once)).toBe(once);
  });

  it('leaves credential-free text alone', () => {
    const clean = 'fatal: repository https://github.com/cs52/content-cs52.git not found';
    expect(redactAccessTokens(clean)).toBe(clean);
    expect(redactAccessTokens('')).toBe('');
  });
});
