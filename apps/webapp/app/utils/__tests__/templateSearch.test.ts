import { describe, expect, it } from 'vitest';
import { groupTemplateOptions, orderTemplateResults } from '../templateSearch';

const repo = (full_name: string, opts: { private?: boolean; is_template?: boolean } = {}) => ({
  name: full_name.split('/')[1],
  full_name,
  description: null,
  updated_at: null,
  private: opts.private ?? false,
  is_template: opts.is_template ?? false,
  language: null,
  stargazers_count: 0,
});

describe('orderTemplateResults', () => {
  it('puts the class org first (private before public), then public templates elsewhere', () => {
    const result = orderTemplateResults({
      orgLogin: 'labs',
      orgItems: [
        repo('labs/lab-old-public'),
        repo('labs/lab-public-template', { is_template: true }),
        repo('labs/lab-private', { private: true }),
        repo('labs/lab-private-template', { private: true, is_template: true }),
        repo('labs/lab-private-plain', { private: true }),
      ],
      publicItems: [repo('someone/lab-starter', { is_template: true })],
      excluded: new Set(),
      limit: 50,
    });

    expect(result.map(r => [r.full_name, r.group])).toEqual([
      ['labs/lab-private-template', 'class'],
      ['labs/lab-private', 'class'],
      ['labs/lab-private-plain', 'class'],
      ['labs/lab-public-template', 'class'],
      ['labs/lab-old-public', 'class'],
      ['someone/lab-starter', 'public'],
    ]);
  });

  it("keeps the org entry for the org's own public repos and drops excluded student repos", () => {
    const result = orderTemplateResults({
      orgLogin: 'labs',
      orgItems: [repo('Labs/lab-bash', { is_template: true }), repo('labs/lab-bash-alice')],
      publicItems: [
        repo('labs/lab-bash', { is_template: true }),
        repo('other/lab-bash', { is_template: true }),
      ],
      excluded: new Set(['labs/lab-bash-alice']),
      limit: 50,
    });

    expect(result.map(r => [r.full_name, r.group])).toEqual([
      ['Labs/lab-bash', 'class'],
      ['other/lab-bash', 'public'],
    ]);
  });

  it('cuts at the limit after ordering, so the class org is never crowded out', () => {
    const result = orderTemplateResults({
      orgLogin: 'labs',
      orgItems: [repo('labs/a'), repo('labs/b')],
      publicItems: [repo('x/a'), repo('x/b'), repo('x/c')],
      excluded: new Set(),
      limit: 3,
    });
    expect(result.map(r => r.full_name)).toEqual(['labs/a', 'labs/b', 'x/a']);
  });

  it("keeps the org's own repos in its group when only the public search answered", () => {
    const result = orderTemplateResults({
      orgLogin: 'Labs',
      orgItems: [],
      publicItems: [
        repo('other/lab-bash', { is_template: true }),
        repo('labs/lab-bash', { is_template: true }),
      ],
      excluded: new Set(),
      limit: 50,
    });
    expect(result.map(r => [r.full_name, r.group])).toEqual([
      ['labs/lab-bash', 'class'],
      ['other/lab-bash', 'public'],
    ]);
  });
});

describe('groupTemplateOptions', () => {
  it('builds titled groups in order and skips empty ones', () => {
    const items = orderTemplateResults({
      orgLogin: 'labs',
      orgItems: [repo('labs/a', { private: true })],
      publicItems: [repo('x/b', { is_template: true })],
      excluded: new Set(),
      limit: 50,
    });
    const options = groupTemplateOptions(items, r => r.full_name);
    expect(options).toEqual([
      {
        label: 'Your templates',
        title: 'Your templates',
        options: [{ value: 'labs/a', label: 'labs/a' }],
      },
      {
        label: 'Public templates',
        title: 'Public templates',
        options: [{ value: 'x/b', label: 'x/b' }],
      },
    ]);

    const orgOnly = groupTemplateOptions(items.slice(0, 1), r => r.full_name);
    expect(orgOnly.map(g => g.label)).toEqual(['Your templates']);
  });
});
