/**
 * templateImport.service pure helpers: parseTemplateRef, formatTemplateRef,
 * templateRefKey, groupTemplateRefs, templateNameCandidates, formatWarning.
 * No DB/GitHub — the orchestrator's IO paths are out of scope here (repo
 * pure-only test convention). The runtime-heavy imports the service pulls in at
 * module load are stubbed so importing it is cheap.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../content/ContentService.ts', () => ({ ContentService: {} }));
vi.mock('../../git/index.ts', () => ({ getGitProvider: vi.fn() }));

const {
  parseTemplateRef,
  formatTemplateRef,
  templateRefKey,
  groupTemplateRefs,
  templateNameCandidates,
  formatWarning,
} = await import('../templateImport.service.ts');

describe('parseTemplateRef', () => {
  it('splits the canonical owner-qualified form the repo form writes', () => {
    expect(parseTemplateRef('cs101-org/lab1-template', 'fallback')).toEqual({
      owner: 'cs101-org',
      name: 'lab1-template',
    });
  });

  it('resolves a bare name (repo_create over MCP allows it) against the fallback owner', () => {
    expect(parseTemplateRef('lab1-template', 'src-org')).toEqual({
      owner: 'src-org',
      name: 'lab1-template',
    });
  });

  it('trims surrounding whitespace and stray slashes', () => {
    expect(parseTemplateRef('  org/lab1  ', 'x')).toEqual({ owner: 'org', name: 'lab1' });
    expect(parseTemplateRef('/org/lab1/', 'x')).toEqual({ owner: 'org', name: 'lab1' });
    expect(parseTemplateRef('org / lab1', 'x')).toEqual({ owner: 'org', name: 'lab1' });
  });

  it('recovers a half-written ref as a bare name — the read then 404s and keeps the link', () => {
    expect(parseTemplateRef('org/', 'fallback')).toEqual({ owner: 'fallback', name: 'org' });
  });

  it('returns null for empty, whitespace-only, or absent refs', () => {
    expect(parseTemplateRef('', 'org')).toBeNull();
    expect(parseTemplateRef('   ', 'org')).toBeNull();
    expect(parseTemplateRef(null, 'org')).toBeNull();
    expect(parseTemplateRef(undefined, 'org')).toBeNull();
  });

  it('returns null for a bare name with no fallback owner to resolve against', () => {
    expect(parseTemplateRef('lab1', '')).toBeNull();
  });

  it('returns null for refs carrying more path segments than a repo ref can hold', () => {
    expect(parseTemplateRef('org/a/b', 'x')).toBeNull();
    expect(parseTemplateRef('https://github.com/org/lab1', 'x')).toBeNull();
  });
});

describe('formatTemplateRef', () => {
  it("always produces owner/name — the format every template.split('/') consumer needs", () => {
    expect(formatTemplateRef({ owner: 'org', name: 'lab1' })).toBe('org/lab1');
  });
});

describe('templateRefKey', () => {
  it('lowercases both halves (GitHub logins and repo names are case-insensitive)', () => {
    expect(templateRefKey({ owner: 'CS101-Org', name: 'Lab1' })).toBe('cs101-org/lab1');
    expect(templateRefKey({ owner: 'cs101-org', name: 'lab1' })).toBe(
      templateRefKey({ owner: 'CS101-ORG', name: 'LAB1' })
    );
  });
});

describe('groupTemplateRefs', () => {
  it('collapses rows sharing one template into a single group', () => {
    const groups = groupTemplateRefs(
      [{ template: 'src/lab1' }, { template: 'src/lab1' }, { template: 'src/lab2' }],
      'src'
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ ref: { owner: 'src', name: 'lab1' }, rawRefs: ['src/lab1'] });
    expect(groups[1]!.ref.name).toBe('lab2');
  });

  it('groups bare and owner-qualified spellings of the same repo, keeping both raw refs', () => {
    const groups = groupTemplateRefs([{ template: 'lab1' }, { template: 'src/lab1' }], 'src');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ref).toEqual({ owner: 'src', name: 'lab1' });
    // Relinks match on the exact stored strings, so BOTH spellings are retained.
    expect(groups[0]!.rawRefs).toEqual(['lab1', 'src/lab1']);
  });

  it('groups case-variant spellings but keeps each distinct raw ref', () => {
    const groups = groupTemplateRefs([{ template: 'Src/Lab1' }, { template: 'src/lab1' }], 'src');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rawRefs).toEqual(['Src/Lab1', 'src/lab1']);
  });

  it('does not repeat an identical raw ref in rawRefs', () => {
    const groups = groupTemplateRefs([{ template: 'src/lab1' }, { template: 'src/lab1' }], 'src');
    expect(groups[0]!.rawRefs).toEqual(['src/lab1']);
  });

  it('skips null and empty templates', () => {
    expect(
      groupTemplateRefs([{ template: null }, { template: '' }, { template: '  ' }], 'src')
    ).toEqual([]);
  });

  it('keeps templates owned by a third org as their own group (the caller warns)', () => {
    const groups = groupTemplateRefs([{ template: 'other-org/lab1' }, { template: 'lab1' }], 'src');
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.ref.owner)).toEqual(['other-org', 'src']);
  });
});

describe('templateNameCandidates', () => {
  it('prefers the original name, then the namespace-qualified one, then numbers', () => {
    expect(templateNameCandidates('lab1-template', 'cs101-w26', 4)).toEqual([
      'lab1-template',
      'lab1-template-cs101-w26',
      'lab1-template-cs101-w26-2',
      'lab1-template-cs101-w26-3',
    ]);
  });

  it('skips the duplicate namespaced entry when there is no namespace', () => {
    expect(templateNameCandidates('lab1', '', 3)).toEqual(['lab1', 'lab1-2', 'lab1-3']);
  });

  it('never emits a duplicate candidate', () => {
    const candidates = templateNameCandidates('lab1', 'w26', 8);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("clamps every candidate to GitHub's 100-character repo-name limit", () => {
    const candidates = templateNameCandidates('a'.repeat(120), 'b'.repeat(40), 5);
    for (const candidate of candidates) {
      expect(candidate.length).toBeLessThanOrEqual(100);
    }
    expect(candidates[0]).toBe('a'.repeat(100));
    // Name and namespaced form clamp to the same 100 chars — deduped, so the
    // numbered variants start immediately rather than re-probing a dead name.
    expect(candidates[1]!.endsWith('-2')).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('honours the candidate limit', () => {
    expect(templateNameCandidates('lab1', 'w26', 1)).toEqual(['lab1']);
    expect(templateNameCandidates('lab1', 'w26')).toHaveLength(10);
  });
});

describe('formatWarning', () => {
  it('joins scope and detail', () => {
    expect(formatWarning('template src/lab1', 'skipped')).toBe('template src/lab1: skipped');
  });

  it('truncates detail past 200 characters with an ellipsis', () => {
    const warning = formatWarning('scope', 'x'.repeat(250));
    expect(warning).toBe(`scope: ${'x'.repeat(200)}…`);
  });

  it('leaves detail at the limit untouched', () => {
    expect(formatWarning('scope', 'x'.repeat(200))).toBe(`scope: ${'x'.repeat(200)}`);
  });
});
