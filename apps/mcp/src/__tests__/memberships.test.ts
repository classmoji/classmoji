/**
 * The identity surface lists one entry per classroom, with every role held
 * there (#846): a user holding three roles in one classroom used to see it
 * three times, STUDENT before OWNER.
 */

import { describe, expect, it } from 'vitest';
import { summarizeMemberships } from '../memberships.ts';

const row = (id: string, role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT', slug = id) => ({
  id,
  slug,
  name: `Class ${id}`,
  status: 'ACTIVE',
  is_archived: false,
  git_organization: { login: 'org' },
  membership: { role },
});

describe('summarizeMemberships', () => {
  it('folds every role held in one classroom into one entry, highest first', () => {
    const out = summarizeMemberships([
      row('c1', 'ASSISTANT'),
      row('c2', 'STUDENT'),
      row('c1', 'STUDENT'),
      row('c1', 'OWNER'),
    ]);

    expect(out).toEqual([
      {
        classroom: 'org/c1',
        name: 'Class c1',
        role: 'OWNER',
        roles: ['OWNER', 'ASSISTANT', 'STUDENT'],
        status: 'ACTIVE',
        is_archived: false,
      },
      {
        classroom: 'org/c2',
        name: 'Class c2',
        role: 'STUDENT',
        roles: ['STUDENT'],
        status: 'ACTIVE',
        is_archived: false,
      },
    ]);
  });

  it('keeps two classrooms with the same slug apart (by id)', () => {
    const out = summarizeMemberships([row('a', 'OWNER', 'cs1'), row('b', 'STUDENT', 'cs1')]);
    expect(out).toHaveLength(2);
  });

  it('lists a repeated role once', () => {
    expect(summarizeMemberships([row('c1', 'TEACHER'), row('c1', 'TEACHER')])[0].roles).toEqual([
      'TEACHER',
    ]);
  });

  it('returns nothing for no memberships', () => {
    expect(summarizeMemberships([])).toEqual([]);
  });
});
