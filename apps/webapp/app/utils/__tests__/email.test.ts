/**
 * The shared address check behind registration, account settings and
 * sendEmailVerificationCode (#396): reject what Resend refuses as a `to`,
 * accept the addresses people actually have.
 */

import { describe, expect, it } from 'vitest';
import { isValidEmail, normalizeEmail } from '../email';

describe('isValidEmail', () => {
  it.each([
    'student@school.edu',
    'first.last@dartmouth.edu',
    'student+cs52@school.edu',
    'jane@mail.dartmouth.edu',
    'j.doe@cs.ox.ac.uk',
    "o'brien@school.edu",
    'under_score-dash@sub-domain.school.edu',
    '12345@school.edu',
    'ñandú@universidad.es',
    'user@bücher.de',
    'user@xn--bcher-kva.de',
    '用户@例子.广告',
  ])('accepts %s', email => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a number (the issue example)', '1234567'],
    ['a bare username', 'jdoe'],
    ['no domain', 'jdoe@'],
    ['no local part', '@school.edu'],
    ['no TLD', 'jdoe@localhost'],
    ['two @', 'a@b@school.edu'],
    ['inner whitespace', 'j doe@school.edu'],
    ['a comma-separated list', 'a@school.edu,b@school.edu'],
    ['a comma in the local part', 'a,b@school.edu'],
    ['a display name with angle brackets', 'Jane <jane@school.edu>'],
    ['angle brackets only', '<jane@school.edu>'],
    ['consecutive dots in the local part', 'jane..doe@school.edu'],
    ['consecutive dots in the domain', 'jane@school..edu'],
    ['a leading dot', '.jane@school.edu'],
    ['a trailing dot in the local part', 'jane.@school.edu'],
    ['a trailing dot on the domain', 'jane@school.edu.'],
    ['a domain starting with a dot', 'jane@.school.edu'],
    ['a label starting with a hyphen', 'jane@-school.edu'],
    ['a label ending with a hyphen', 'jane@school-.edu'],
    ['a numeric TLD (bare IP)', 'jane@127.0.0.1'],
    ['an IP literal', 'jane@[127.0.0.1]'],
    ['a quoted local part', '"jane doe"@school.edu'],
    ['a semicolon', 'jane;x@school.edu'],
    ['an over-long local part', `${'a'.repeat(65)}@school.edu`],
    ['an over-long domain label', `jane@${'b'.repeat(64)}.edu`],
    ['an over-long address', `a@${['b', 'c', 'd', 'e'].map(c => c.repeat(63)).join('.')}.edu`],
  ])('rejects %s', (_label, email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases a valid address', () => {
    expect(normalizeEmail('  Jane.Doe+CS@Mail.Dartmouth.EDU \n')).toBe(
      'jane.doe+cs@mail.dartmouth.edu'
    );
  });

  it('returns null for non-strings and invalid addresses', () => {
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(1234567)).toBeNull();
    expect(normalizeEmail({ email: 'a@b.co' })).toBeNull();
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail('jdoe')).toBeNull();
  });
});
