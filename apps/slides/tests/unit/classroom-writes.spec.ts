/**
 * The classroom-status rule on every slides write: in a LOCKED or UNPUBLISHED
 * classroom only the owner may change anything; an ACTIVE classroom is
 * unchanged.
 *
 * The decision (app/utils/classroomWrites.ts) is pinned directly. Where each
 * write route applies it is pinned by reading the route source, as the other
 * gate specs here do: AFTER the route's own access gate (the rule never
 * decides who may see a deck) and BEFORE the write it guards. The behaviour
 * against a real database is exercised by the run-for-real check of this
 * change, not here (these specs run without Postgres).
 *
 * Runs in the Playwright runner without a browser or the dev stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  DECK_READ_INTENTS,
  classroomWriteBlock,
  classroomWriteRefusal,
} from '../../app/utils/classroomWrites.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test.describe('the decision', () => {
  test('a teacher or assistant in a LOCKED classroom is refused with the locked code', () => {
    for (const role of ['TEACHER', 'ASSISTANT']) {
      expect(classroomWriteBlock('LOCKED', role)).toEqual({
        error: 'This class is in read-only mode. The owner has locked it.',
        code: 'CLASSROOM_LOCKED',
      });
    }
  });

  test('a teacher in an UNPUBLISHED classroom is refused with the unpublished code', () => {
    expect(classroomWriteBlock('UNPUBLISHED', 'TEACHER')).toMatchObject({
      code: 'CLASSROOM_UNPUBLISHED',
    });
  });

  test('the owner may write in any state', () => {
    for (const status of ['ACTIVE', 'LOCKED', 'UNPUBLISHED']) {
      expect(classroomWriteBlock(status, 'OWNER')).toBeNull();
    }
  });

  test('an ACTIVE classroom is unchanged for its teaching team', () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT']) {
      expect(classroomWriteBlock('ACTIVE', role)).toBeNull();
    }
  });

  test('no role or no status refuses', () => {
    expect(classroomWriteBlock('ACTIVE', null)).not.toBeNull();
    expect(classroomWriteBlock(undefined, 'TEACHER')).not.toBeNull();
  });

  test('the refusal is a 403 carrying the code and the extra fields the client keys on', async () => {
    const refusal = classroomWriteRefusal('LOCKED', 'TEACHER', { intent: 'update-visibility' });
    expect(refusal).not.toBeNull();
    expect(refusal!.init?.status).toBe(403);
    expect(refusal!.data).toMatchObject({
      intent: 'update-visibility',
      code: 'CLASSROOM_LOCKED',
    });
    expect(classroomWriteRefusal('LOCKED', 'OWNER', { intent: 'x' })).toBeNull();
  });
});

test.describe('the deck action', () => {
  const DECK = source('../../app/routes/$slideId/route.tsx');
  const action = DECK.slice(DECK.indexOf('export const action = async'));

  test('only the reads skip the rule', () => {
    expect([...DECK_READ_INTENTS].sort()).toEqual(
      [
        'collab-orphaned-images',
        'fetch-latest',
        'get-theme-content',
        'list-snippets',
        'list-themes',
      ].sort()
    );
  });

  test('applies it after the edit gate and before the first intent that writes', () => {
    const gate = action.indexOf("accessType: 'edit',");
    const rule = action.indexOf('classroomWriteRefusal(slide.classroom.status, membership?.role');
    const firstWrite = action.indexOf("if (intent === 'collab-save-version')");
    for (const at of [gate, rule, firstWrite]) expect(at).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(rule);
    expect(rule).toBeLessThan(firstWrite);
    for (const write of [
      "intent === 'upload-image'",
      "intent === 'save-snippet'",
      "intent === 'delete-images'",
      "intent === 'update-visibility'",
      "intent === 'preview-accept'",
    ]) {
      expect(action.indexOf(write), write).toBeGreaterThan(rule);
    }
  });
});

test.describe('the other write routes', () => {
  const cases: Array<[string, string, string, string]> = [
    // [file, gate marker, rule marker, first write marker]
    [
      '../../app/routes/$classroomSlug.new/route.tsx',
      'await requireClassroomTeachingTeam(',
      'classroomWriteRefusal(classroom.status, membership?.role)',
      'return createFromForm(',
    ],
    [
      '../../app/routes/$classroomSlug.$slideId.delete/route.tsx',
      "accessType: 'edit',",
      'classroomWriteRefusal(',
      'await slideService.deleteSlide(',
    ],
    [
      '../../app/routes/$classroomSlug.$slideId.link/route.tsx',
      'await authorizeLinkSlide(request, classroomSlug, slideId);\n  // Changing',
      'classroomWriteRefusal(slide.classroom?.status, membership?.role)',
      'await slideFileService.updateSlideLink(',
    ],
    [
      '../../app/routes/$classroomSlug.$slideId.replace/route.tsx',
      'await authorizeFileSlide(request, classroomSlug, slideId);\n  // Replacing',
      'classroomWriteRefusal(slide.classroom?.status, membership?.role)',
      'return replaceFromMedia(',
    ],
    [
      '../../app/routes/api.slides.$slideId.html-block/route.ts',
      "accessType: 'edit',",
      'classroomWriteBlock(slide.classroom.status, membership?.role)',
      'await handleHtmlBlockRequest(',
    ],
  ];

  for (const [file, gateMarker, ruleMarker, writeMarker] of cases) {
    test(`${file.split('/routes/')[1]}: gate, then the rule, then the write`, () => {
      const text = source(file);
      const body = text.slice(text.indexOf('export const action'));
      const gate = body.indexOf(gateMarker);
      const rule = body.indexOf(ruleMarker);
      const write = body.indexOf(writeMarker);
      for (const at of [gate, rule, write]) expect(at).toBeGreaterThan(-1);
      expect(gate).toBeLessThan(rule);
      expect(rule).toBeLessThan(write);
    });
  }

  test('the slides list applies it to delete, rename and duplicate after each gate', () => {
    const text = source('../../app/routes/_index/route.tsx');
    for (const [intent, write] of [
      ['delete', 'await slideService.deleteSlide('],
      ['rename', 'await getPrisma().slide.update('],
      ['duplicate', 'const slide = await getPrisma().slide.findUnique('],
    ]) {
      const branch = text.slice(text.indexOf(`if (intent === '${intent}')`));
      const gate = branch.indexOf('access = await assertSlideAccess(');
      const rule = branch.indexOf(`writeRefusal(access, '${intent}')`);
      const firstWrite = branch.indexOf(write);
      for (const at of [gate, rule, firstWrite]) expect(at, intent).toBeGreaterThan(-1);
      expect(gate, intent).toBeLessThan(rule);
      expect(rule, intent).toBeLessThan(firstWrite);
    }
  });
});
