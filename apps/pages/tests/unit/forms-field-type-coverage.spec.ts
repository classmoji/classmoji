import { test, expect } from '@playwright/test';
import {
  FIELD_TYPES,
  FIELD_TYPE_REGISTRY,
  parseFormDefinition,
  type FormField,
  type FormFieldType,
} from '@classmoji/services/form-contract';

import { FIELD_TYPE_META, makeField, metaFor } from '../../app/components/forms/fieldTypes';
import { coerceValue, defaultValueFor } from '../../app/components/forms/answerCoerce';
import {
  formatAnswer,
  isDisplayOnly,
  isScalarField,
} from '../../app/components/forms/answerFormat';

/**
 * EVERY field type in the registry is handled by the presentation layer.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 * The contract's registry is the single declaration site, and the VALIDATION
 * layer really is derived from it. The presentation layer — renderer, preview,
 * config panel, formatter, palette — cannot be, so each of those dispatches is
 * typed over `FormFieldType` and ends in `unhandledFieldType`, which makes a new
 * registry entry a compile error until it is handled.
 *
 * That is the primary guarantee and it is enforced by `tsc`, not here. This file
 * covers the part a type checker cannot: that the code behind each of those
 * cases actually RUNS for every declared type. A `case 'date': return null;`
 * added purely to silence the compiler would satisfy the type system and fail
 * here, which is exactly the failure mode a compile-time-only guarantee invites.
 *
 * ── Why in the Playwright runner ───────────────────────────────────────────
 * Same reason as `forms-origin.spec.ts` and `forms-paths.spec.ts`: these modules
 * are deliberately pure and browser-safe, so they can be tested as the plain
 * functions they are, with no browser and no dev stack.
 */

/** The registry order, as a list of types the tests iterate. */
const TYPES: FormFieldType[] = [...FIELD_TYPES];

test('the registry is not empty and every type is one of the two kinds', () => {
  expect(TYPES.length).toBeGreaterThan(10);
  for (const type of TYPES) {
    expect(['input', 'display']).toContain(FIELD_TYPE_REGISTRY[type].kind);
  }
});

test('the builder palette offers exactly the registry, with a real label each', () => {
  // Not "a superset" and not "a subset": a palette entry with no registry type
  // saves nothing, and a registry type with no entry is unreachable from the UI.
  expect(FIELD_TYPE_META.map(meta => meta.type).sort()).toEqual([...TYPES].sort());

  for (const meta of FIELD_TYPE_META) {
    // The old `META[type]?.label ?? type` fallback would have passed a raw
    // `repeat_group` off as a label; a palette button reading like an
    // identifier is the visible symptom of an unhandled type.
    expect(meta.label, meta.type).not.toBe(meta.type);
    expect(meta.label.trim().length, meta.type).toBeGreaterThan(0);
    expect(meta.hint.trim().length, meta.type).toBeGreaterThan(0);
    expect(metaFor(meta.type)).toEqual(meta);
  }
});

test('every type has a starter field the CONTRACT accepts', () => {
  // The strongest available statement about `makeField`: the builder drops one
  // of these onto the canvas and the server must be willing to store it. A
  // starter shape that only looks right is a field the instructor cannot save.
  for (const type of TYPES) {
    const field = makeField(type);
    expect(field.type, type).toBe(type);
    expect(typeof field.id, type).toBe('string');

    const parsed = parseFormDefinition([field]);
    expect(parsed.fields, type).toHaveLength(1);
    expect(parsed.fields[0].type, type).toBe(type);
  }
});

test('every type has a defined starting value and a coercion that runs', () => {
  for (const type of TYPES) {
    const field = makeField(type);

    // `undefined` is the one answer that is never right: every control is
    // controlled, and a value that appears mid-edit loses the first keystroke.
    const seed = defaultValueFor(field);
    expect(seed, type).not.toBeUndefined();

    // And the coercion accepts what the control would hand back, including the
    // empty-string shape a blank DOM input produces.
    expect(() => coerceValue(field, seed), type).not.toThrow();
    expect(() => coerceValue(field, ''), type).not.toThrow();
  }
});

test('every type formats an answer, and knows whether it fits a column', () => {
  for (const type of TYPES) {
    const field = makeField(type);

    expect(() => formatAnswer(field, defaultValueFor(field)), type).not.toThrow();
    // An unanswered field is blank — never "false", never "0", never
    // "[object Object]".
    expect(formatAnswer(field, null), type).toBe('');

    // The layout classification is total: display, wide, or scalar, and the
    // first two are mutually exclusive with the third.
    const display = isDisplayOnly(field);
    const scalar = isScalarField(field);
    expect(display && scalar, type).toBe(false);
    expect(display, type).toBe(FIELD_TYPE_REGISTRY[type].kind === 'display');
  }
});

test('an unknown field type is refused loudly rather than degraded quietly', () => {
  // The runtime half of the guarantee: a stored revision naming a type THIS
  // build does not know (an older deployment reading a newer definition) must
  // not render as a text box and export as a raw value. `never` cannot be
  // produced legitimately, so the cast is the point of the test.
  const alien = { id: 'x', type: 'date' } as unknown as FormField;

  expect(() => defaultValueFor(alien)).toThrow(/no case for field type/);
  expect(() => coerceValue(alien, 'anything')).toThrow(/no case for field type/);
  expect(() => formatAnswer(alien, 'anything')).toThrow(/no case for field type/);
  expect(() => makeField('date' as FormFieldType)).toThrow(/no case for field type/);
});
