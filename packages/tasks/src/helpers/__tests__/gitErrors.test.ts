import { describe, expect, it } from 'vitest';
import {
  appPermissionDeniedMessage,
  isAppPermissionDenied,
  isRepoNotFound,
  templateNotFoundMessage,
} from '../gitErrors.ts';
import { isTransientGitError } from '../gitRetry.ts';

// Messages from failed prod runs.
const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { name: 'HttpError', status });
const gitError = (message: string) => Object.assign(new Error(message), { name: 'GitError' });

const PERMISSION_DENIED = httpError(
  403,
  'Resource not accessible by integration - https://docs.github.com/rest/collaborators/collaborators#add-a-repository-collaborator'
);
const TEMPLATE_GONE = gitError(
  "remote: Repository not found.\nfatal: repository 'https://github.com/acme/tp3-template.git/' not found"
);

describe('isAppPermissionDenied', () => {
  it('recognises Github refusing the app in the org', () => {
    expect(isAppPermissionDenied(PERMISSION_DENIED)).toBe(true);
  });

  it('does not take other errors for it', () => {
    expect(isAppPermissionDenied(httpError(403, 'API rate limit exceeded'))).toBe(false);
    expect(isAppPermissionDenied(httpError(404, 'Not Found'))).toBe(false);
    expect(isAppPermissionDenied(httpError(500, 'Resource not accessible by integration'))).toBe(
      false
    );
    expect(isAppPermissionDenied(undefined)).toBe(false);
  });

  it('is not retried', () => {
    expect(isTransientGitError(PERMISSION_DENIED)).toBe(false);
  });
});

describe('isRepoNotFound', () => {
  it('recognises a template git cannot find', () => {
    expect(isRepoNotFound(TEMPLATE_GONE)).toBe(true);
  });

  it('does not take a network failure for it', () => {
    expect(
      isRepoNotFound(
        gitError(
          "fatal: unable to access 'https://github.com/acme/hw1.git/': Failed to connect to github.com port 443"
        )
      )
    ).toBe(false);
    expect(isRepoNotFound(new Error('boom'))).toBe(false);
  });
});

describe('messages', () => {
  it('say what to fix and where', () => {
    expect(appPermissionDeniedMessage('esih-classroom', 'tp2-ada')).toContain(
      'esih-classroom/tp2-ada'
    );
    expect(appPermissionDeniedMessage('esih-classroom', 'tp2-ada')).toContain('run Sync');
    expect(templateNotFoundMessage('acme/tp3-template')).toContain('acme/tp3-template');
  });
});
