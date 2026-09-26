import { describe, expect, it } from 'vitest';
import {
  REPO_REST_MAX_BYTES,
  REPO_REST_MAX_LABEL,
  exceedsRepoFileLimit,
  formatMegabytes,
  repoFileSkippedWarning,
  repoFileTooLargeMessage,
} from '../repoLimits.ts';

describe('repo file limit', () => {
  it('is 35 MiB, and reads as 35 MB', () => {
    expect(REPO_REST_MAX_BYTES).toBe(35 * 1024 * 1024);
    expect(REPO_REST_MAX_LABEL).toBe('35 MB');
  });

  it('allows a file exactly at the cap and refuses one byte over', () => {
    expect(exceedsRepoFileLimit(REPO_REST_MAX_BYTES)).toBe(false);
    expect(exceedsRepoFileLimit(REPO_REST_MAX_BYTES + 1)).toBe(true);
    expect(exceedsRepoFileLimit(0)).toBe(false);
  });

  it('quotes the derived label in every sentence', () => {
    expect(repoFileTooLargeMessage()).toBe(
      'This file is larger than the 35 MB your course repository accepts.'
    );
    expect(repoFileTooLargeMessage('scan.png')).toBe(
      'scan.png is larger than the 35 MB your course repository accepts.'
    );
    expect(repoFileSkippedWarning('lecture.mp4', 120 * 1024 * 1024)).toBe(
      'Skipped lecture.mp4 (120 MB) — larger than the 35 MB your course repository accepts'
    );
  });

  it('keeps one decimal below 100 MB so a near-miss does not read as a contradiction', () => {
    expect(formatMegabytes(35.4 * 1024 * 1024)).toBe('35.4 MB');
    expect(formatMegabytes(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatMegabytes(120.4 * 1024 * 1024)).toBe('120 MB');
  });
});
