/**
 * The duplicate-key checks on REAL unique-violation errors from both Prisma
 * clients (@classmoji/database/testing/prisma-errors): Prisma 6 names the
 * fields in `meta.target`; Prisma 7 on the pg adapter names the constraint in
 * `meta.driverAdapterError.cause.constraint.index` and has no `meta.target`.
 * Every check must recognise its own constraint on both, and nothing else
 * (see the one Prisma 6 exception below).
 */
import { describe, expect, it } from 'vitest';
import {
  PRISMA_6_ERRORS,
  PRISMA_7_ERRORS,
  type CapturedErrors,
} from '@classmoji/database/testing/prisma-errors';
import { uniqueViolationTarget } from '../uniqueViolation.ts';
import { isClassroomSlugConflict } from '../classroomSlug.ts';
import { isFormSlugConflict } from '../form.service.ts';
import { isModuleItemDuplicate } from '../module.service.ts';
import { isPageSlugConflict } from '../page.service.ts';
import { isCustomDomainConflict, isSubdomainConflict } from '../site.service.ts';
import { isSlideSlugConflict } from '../../slides/slide.service.ts';

/** Each check, and the captured violation of the constraint it looks for. */
const CHECKS: Array<[string, (error: unknown) => boolean, string]> = [
  ['isClassroomSlugConflict', isClassroomSlugConflict, 'p2002_classroom_slug'],
  ['isFormSlugConflict', isFormSlugConflict, 'p2002_form_slug'],
  ['isPageSlugConflict', isPageSlugConflict, 'p2002_page_slug'],
  ['isSlideSlugConflict', isSlideSlugConflict, 'p2002_slide_slug'],
  ['isModuleItemDuplicate', isModuleItemDuplicate, 'p2002_module_item'],
  ['isSubdomainConflict', isSubdomainConflict, 'p2002_site_subdomain'],
  ['isCustomDomainConflict', isCustomDomainConflict, 'p2002_site_custom_domain'],
];

/** Every captured constraint error: the seven above, a unique email, a foreign key. */
const CASES = [...CHECKS.map(([, , key]) => key), 'p2002_user_email', 'p2003_fk'];

/**
 * Prisma 6 reports a unique violation by its FIELDS, and forms, pages and
 * slides share one field set, (classroom_id, slug): their three checks cannot
 * tell those models apart there. Harmless (each check only ever sees errors
 * from writing its own model) and unchanged from before; Prisma 7 names the
 * index, which does tell them apart.
 */
const SAME_FIELDS_ON_PRISMA_6 = ['p2002_form_slug', 'p2002_page_slug', 'p2002_slide_slug'];

describe.each([
  ['Prisma 6.19.3', PRISMA_6_ERRORS],
  ['Prisma 7.10.1', PRISMA_7_ERRORS],
] as Array<[string, CapturedErrors]>)('%s', (label, errors) => {
  it('the fixtures are the version they claim', () => {
    expect(errors.prisma).toBe(label.split(' ')[1]);
    for (const key of CASES) expect(errors[key]?.code, key).toMatch(/^P200[23]$/);
  });

  it.each(CHECKS)('%s recognises its own constraint and no other', (name, check, own) => {
    for (const key of CASES) {
      const expected =
        key === own ||
        (label.startsWith('Prisma 6') &&
          SAME_FIELDS_ON_PRISMA_6.includes(own) &&
          SAME_FIELDS_ON_PRISMA_6.includes(key));
      expect(check(errors[key]), `${name}(${key})`).toBe(expected);
    }
  });
});

describe('uniqueViolationTarget', () => {
  it('reads meta.target on Prisma 6 (the field names)', () => {
    expect(uniqueViolationTarget(PRISMA_6_ERRORS.p2002_user_email)).toEqual(['email']);
    expect(uniqueViolationTarget(PRISMA_6_ERRORS.p2002_form_slug)).toEqual([
      'classroom_id',
      'slug',
    ]);
  });

  it('reads the constraint on Prisma 7 (no meta.target there)', () => {
    expect(PRISMA_7_ERRORS.p2002_user_email.meta).not.toHaveProperty('target');
    expect(uniqueViolationTarget(PRISMA_7_ERRORS.p2002_user_email)).toBe('users_email_key');
    expect(uniqueViolationTarget(PRISMA_7_ERRORS.p2002_form_slug)).toBe(
      'forms_classroom_id_slug_key'
    );
  });

  it('prefers meta.target, then constraint fields, then the index name', () => {
    expect(
      uniqueViolationTarget({
        meta: { target: ['a'], driverAdapterError: { cause: { constraint: { index: 'x' } } } },
      })
    ).toEqual(['a']);
    expect(
      uniqueViolationTarget({
        meta: { driverAdapterError: { cause: { constraint: { fields: ['b', 'c'] } } } },
      })
    ).toEqual(['b', 'c']);
  });

  it('takes the constraint fields before its index name', () => {
    expect(
      uniqueViolationTarget({
        meta: { driverAdapterError: { cause: { constraint: { fields: ['b'], index: 'x_key' } } } },
      })
    ).toEqual(['b']);
  });

  it('a null meta.target falls through to the adapter constraint', () => {
    expect(
      uniqueViolationTarget({
        meta: {
          target: null,
          driverAdapterError: { cause: { constraint: { fields: ['b', 'c'], index: 'x_key' } } },
        },
      })
    ).toEqual(['b', 'c']);
    expect(
      uniqueViolationTarget({
        meta: { target: null, driverAdapterError: { cause: { constraint: { index: 'x_key' } } } },
      })
    ).toBe('x_key');
  });

  it('is undefined for anything without either', () => {
    for (const value of [
      null,
      undefined,
      'P2002',
      new Error('boom'),
      { code: 'P2002' },
      { meta: null },
    ]) {
      expect(uniqueViolationTarget(value)).toBeUndefined();
    }
    expect(uniqueViolationTarget({ meta: { driverAdapterError: {} } })).toBeUndefined();
  });
});
