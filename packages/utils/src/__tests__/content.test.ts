import { describe, it, expect } from 'vitest';
import { generateTermString, getContentRepoName } from '../content.ts';

describe('generateTermString', () => {
  it('returns null when term or year is missing', () => {
    expect(generateTermString(undefined, 2026)).toBeNull();
    expect(generateTermString('Winter', undefined)).toBeNull();
    expect(generateTermString(undefined, undefined)).toBeNull();
  });

  it('encodes known terms as <yy><letter>', () => {
    expect(generateTermString('Winter', 2025)).toBe('25w');
    expect(generateTermString('Spring', 2025)).toBe('25s');
    expect(generateTermString('Summer', 2025)).toBe('25u');
    expect(generateTermString('Fall', 2025)).toBe('25f');
  });

  it('falls back to lowercase first char for unknown terms', () => {
    expect(generateTermString('Quarter', 2026)).toBe('26q');
  });

  it('uses the last two digits of the year', () => {
    expect(generateTermString('Fall', 2099)).toBe('99f');
    expect(generateTermString('Fall', 2007)).toBe('07f');
  });
});

describe('getContentRepoName', () => {
  it('uses settings.content_repo_name when set', () => {
    expect(
      getContentRepoName({
        login: 'cs101',
        term: 'Fall',
        year: 2025,
        settings: { content_repo_name: 'custom-repo' },
      })
    ).toBe('custom-repo');
  });

  it('falls back to content-<login>-<term> pattern', () => {
    expect(getContentRepoName({ login: 'cs101', term: 'Fall', year: 2025 })).toBe(
      'content-cs101-25f'
    );
  });

  it('omits term suffix when term info missing', () => {
    expect(getContentRepoName({ login: 'cs101' })).toBe('content-cs101');
  });
});
