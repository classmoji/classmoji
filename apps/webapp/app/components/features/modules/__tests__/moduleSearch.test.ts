import { describe, it, expect } from 'vitest';

import { normalizeModuleQuery, searchModule } from '../moduleSearch';

/** Search on the Modules page (#803): module titles and the rows it shows. */

type Item = { id: string; title: string | null };
type Asg = { id: string; title: string; target?: string | null };

const module = {
  title: 'Where State Lives',
  items: [
    { id: 'p1', title: 'Lab 4: REST Web Platform, Part 1' },
    { id: 's1', title: 'State slides' },
    { id: 'x', title: null },
  ] as Item[],
  assignments: [
    { id: 'a1', title: 'ECSA: Wordle Mobile', target: 'wordle-mobile' },
    { id: 'a2', title: 'Lab 4', target: 'lab4-repo' },
  ] as Asg[],
};

const run = (query: string) =>
  searchModule(
    module,
    normalizeModuleQuery(query),
    (i: Item) => [i.title],
    (a: Asg) => [a.title, a.target]
  );

describe('searchModule', () => {
  it('shows everything when not searching', () => {
    expect(run('   ')).toEqual({
      wholeModule: true,
      items: module.items,
      assignments: module.assignments,
    });
  });

  it('shows the whole module when its own title matches, any case', () => {
    const result = run('where STATE');
    expect(result?.wholeModule).toBe(true);
    expect(result?.items).toHaveLength(3);
    expect(result?.assignments).toHaveLength(2);
  });

  it('shows only the matching rows when items match', () => {
    const result = run('wordle');
    expect(result).toEqual({
      wholeModule: false,
      items: [],
      assignments: [module.assignments[0]],
    });
  });

  it('matches content and assignments together, by substring', () => {
    const result = run('lab 4');
    expect(result?.wholeModule).toBe(false);
    expect(result?.items.map(i => i.id)).toEqual(['p1']);
    expect(result?.assignments.map(a => a.id)).toEqual(['a2']);
  });

  it('matches what an assignment submits through', () => {
    expect(run('lab4-repo')?.assignments.map(a => a.id)).toEqual(['a2']);
  });

  it('hides a module with nothing matching, and ignores missing titles', () => {
    expect(run('kahoot')).toBeNull();
    expect(run('null')).toBeNull();
  });
});
