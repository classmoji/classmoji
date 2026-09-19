/**
 * contentRefs.ts — the URL shapes that address a file in a classroom's OWN
 * content repo, and the ref-splitting both callers share.
 *
 * These are the single point of agreement between the delivery resolver (which
 * strips a prefix off to recover a repo path) and the import rewriter (which
 * swaps one repo's prefix for another's). A hole here shows up twice: as an
 * asset that will not resolve, and as an imported page pointing somewhere that
 * does not exist.
 */

import { describe, it, expect } from 'vitest';
import { extractOwnRepoPath, isCommitRef, splitRawRef } from '../contentRefs.ts';

const LOGIN = 'dartmouth-cs52';
const REPO = 'content-dartmouth-cs52-cs52-25s';
const COMMIT = 'a'.repeat(40);

describe('splitRawRef', () => {
  it('takes one segment as the ref in the short form', () => {
    expect(splitRawRef('main/pages/lab-1/a.png')).toEqual({
      ref: 'main',
      path: 'pages/lab-1/a.png',
    });
  });

  it('keeps refs/heads/{branch} together, which is what the Raw button emits', () => {
    // Splitting on the first slash here yields ref `refs` and path
    // `heads/main/pages/…` — a path no repo has.
    expect(splitRawRef('refs/heads/main/pages/lab-1/a.png')).toEqual({
      ref: 'refs/heads/main',
      path: 'pages/lab-1/a.png',
    });
  });

  it('keeps refs/tags/{tag} together too', () => {
    expect(splitRawRef('refs/tags/v1.2/pages/lab-1/a.png')).toEqual({
      ref: 'refs/tags/v1.2',
      path: 'pages/lab-1/a.png',
    });
  });

  it('handles a branch name with slashes in the short form, as one ref cannot', () => {
    // Positional and unavoidable: `feat/x` is indistinguishable from a ref
    // `feat` and a path starting `x/`. The qualified form above is the fix a
    // caller has when it matters.
    expect(splitRawRef('feat/x/pages/a.png')).toEqual({ ref: 'feat', path: 'x/pages/a.png' });
  });

  it('returns null when there is no path after the ref', () => {
    expect(splitRawRef('main')).toBeNull();
    expect(splitRawRef('/leading')).toBeNull();
  });
});

describe('isCommitRef', () => {
  it('recognizes a 40-hex commit sha, in either case', () => {
    expect(isCommitRef(COMMIT)).toBe(true);
    expect(isCommitRef(COMMIT.toUpperCase())).toBe(true);
  });

  it('rejects branch names, including hex-looking short ones', () => {
    expect(isCommitRef('main')).toBe(false);
    expect(isCommitRef('master')).toBe(false);
    expect(isCommitRef('abc123')).toBe(false);
    expect(isCommitRef(`${COMMIT}0`)).toBe(false);
  });
});

describe('extractOwnRepoPath', () => {
  it('recovers the path from the raw shape on any branch', () => {
    expect(
      extractOwnRepoPath(
        `https://raw.githubusercontent.com/${LOGIN}/${REPO}/main/pages/lab-1/a.png`,
        LOGIN,
        REPO
      )
    ).toBe('pages/lab-1/a.png');
    expect(
      extractOwnRepoPath(
        `https://raw.githubusercontent.com/${LOGIN}/${REPO}/master/pages/lab-1/a.png`,
        LOGIN,
        REPO
      )
    ).toBe('pages/lab-1/a.png');
  });

  it('recovers the path from a fully-qualified refs/heads raw URL', () => {
    // THE regression this guards: the one-segment split returned
    // `heads/main/pages/lab-1/a.png`, which misses the asset map on every
    // lookup, so the asset silently fell back to the legacy path.
    expect(
      extractOwnRepoPath(
        `https://raw.githubusercontent.com/${LOGIN}/${REPO}/refs/heads/main/pages/lab-1/a.png`,
        LOGIN,
        REPO
      )
    ).toBe('pages/lab-1/a.png');
  });

  it('recovers the path from a refs/tags raw URL', () => {
    expect(
      extractOwnRepoPath(
        `https://raw.githubusercontent.com/${LOGIN}/${REPO}/refs/tags/v1/pages/lab-1/a.png`,
        LOGIN,
        REPO
      )
    ).toBe('pages/lab-1/a.png');
  });

  it('refuses a COMMIT-pinned raw URL', () => {
    // It names one exact historical revision. The map holds the DEFAULT
    // BRANCH's content, so resolving this would quietly serve today's bytes for
    // a URL that asked for an old one. Null leaves the original URL in place,
    // which still resolves against GitHub.
    expect(
      extractOwnRepoPath(
        `https://raw.githubusercontent.com/${LOGIN}/${REPO}/${COMMIT}/pages/lab-1/a.png`,
        LOGIN,
        REPO
      )
    ).toBeNull();
  });

  it('recovers the path from the Pages CDN and the content proxy', () => {
    expect(
      extractOwnRepoPath(`https://${LOGIN}.github.io/${REPO}/pages/lab-1/a.png`, LOGIN, REPO)
    ).toBe('pages/lab-1/a.png');
    expect(extractOwnRepoPath(`/content/${LOGIN}/${REPO}/pages/lab-1/a.png`, LOGIN, REPO)).toBe(
      'pages/lab-1/a.png'
    );
  });

  it('drops a query string and percent-decodes once', () => {
    expect(
      extractOwnRepoPath(
        `https://raw.githubusercontent.com/${LOGIN}/${REPO}/main/pages/lab%201/a.png?raw=1`,
        LOGIN,
        REPO
      )
    ).toBe('pages/lab 1/a.png');
  });

  it('returns null for anything that is not this repo', () => {
    expect(extractOwnRepoPath('https://example.com/logo.png', LOGIN, REPO)).toBeNull();
    expect(
      extractOwnRepoPath(
        'https://raw.githubusercontent.com/someone-else/other/main/a.png',
        LOGIN,
        REPO
      )
    ).toBeNull();
    expect(extractOwnRepoPath('data:image/png;base64,AAAA', LOGIN, REPO)).toBeNull();
    expect(extractOwnRepoPath('', LOGIN, REPO)).toBeNull();
  });
});
