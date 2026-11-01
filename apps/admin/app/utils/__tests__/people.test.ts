import { describe, it, expect } from 'vitest';
import { distinctClassrooms, emailDomain, highestRole } from '../people.ts';

describe('highestRole', () => {
  it('takes the highest ACCEPTED role', () => {
    expect(
      highestRole([
        { role: 'STUDENT', has_accepted_invite: true },
        { role: 'OWNER', has_accepted_invite: false },
        { role: 'ASSISTANT', has_accepted_invite: true },
      ])
    ).toBe('ASSISTANT');
  });
  it('is PENDING when nothing is accepted, null with no memberships', () => {
    expect(highestRole([{ role: 'STUDENT', has_accepted_invite: false }])).toBe('PENDING');
    expect(highestRole([])).toBeNull();
  });
});

describe('emailDomain / distinctClassrooms', () => {
  it('lower-cases the domain and tolerates junk', () => {
    expect(emailDomain('A@Dartmouth.EDU')).toBe('dartmouth.edu');
    expect(emailDomain('nope')).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
  it('counts an owner who also teaches the same class once', () => {
    expect(
      distinctClassrooms([{ classroom_id: 'a' }, { classroom_id: 'a' }, { classroom_id: 'b' }])
    ).toBe(2);
  });
});
