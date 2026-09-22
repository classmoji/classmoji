/**
 * The Project Showcase preset, run through the real contract. Pure: no browser,
 * no dev server. What it holds: the preset saves (parse), needs a CLASSROOM form
 * (its roster_select is refused on PUBLIC), and passes the gallery publish
 * rule, so a showcase form created from the drawer can be published without
 * edits.
 */

import { test, expect } from '@playwright/test';
import {
  assertFieldsAllowedForAccess,
  assertGalleryRoles,
  galleryRoleOf,
  parseFormDefinition,
} from '@classmoji/services/form-contract';
import { presetByKey } from '~/components/forms/presets.ts';

test.describe('Project Showcase preset', () => {
  test('is a classroom-only preset that passes the gallery publish rule', () => {
    const preset = presetByKey('showcase');
    expect(preset.key).toBe('showcase');
    expect(preset.requiresClassroom).toBe(true);
    expect(preset.suggestedTitle).toBe('Project Showcase');

    const { fields } = parseFormDefinition(preset.fields());
    // Why requiresClassroom is true: the team roster_select cannot go public.
    expect(() => assertFieldsAllowedForAccess(fields, 'PUBLIC')).toThrow(
      /require Classroom access/
    );
    expect(() => assertGalleryRoles(fields)).not.toThrow();

    const count = (role: string) => fields.filter(field => galleryRoleOf(field) === role).length;
    expect(count('title')).toBe(1);
    expect(count('team')).toBe(1);
    expect(count('link')).toBe(5);
    expect(count('detail')).toBe(2);
    expect(fields.some(field => field.label === 'Demo credentials' && !galleryRoleOf(field))).toBe(
      true
    );
  });
});
