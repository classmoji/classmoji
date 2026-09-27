/**
 * The quiz form's source-material edit round trip.
 *
 *   loader: quiz.source_material → picker values (material order) and the
 *           options that name them
 *   Select: holds those values; selection order is material order
 *   submit: values → fromPickerValue → [{ kind, id }] for the quizzes action
 *
 * Opening a quiz and saving it untouched must write back exactly the list it
 * read, in the same order. Every value the Select holds must have an option,
 * including a linked document the classroom's options leave out (a FILE or
 * LINK slide linked through the MCP tool): without one the Select shows a bare
 * `slide:<id>`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fromPickerValue,
  pickerLabel,
  pickerOptions,
  toPickerValue,
  toPickerValues,
} from '../sourceMaterialPicker';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  findByClassroomId: vi.fn(),
  listSourceMaterialOptions: vi.fn(),
  quizFindById: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: { findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a) },
    quizSourceMaterial: {
      listSourceMaterialOptions: (...a: unknown[]) => mocks.listSourceMaterialOptions(...a),
    },
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
  },
  getExamplePrompts: () => [],
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/hooks', () => ({ useRouteDrawer: vi.fn(), useDarkMode: vi.fn() }));
vi.mock('~/components/quiz/PromptAssistant', () => ({ PromptAssistant: () => null }));

const { loader } = await import('../route');

const CLASS_SLUG = 'cs52-26f';

// What the classroom offers: pages and reveal.js decks, drafts included.
const OFFERED = {
  pages: [
    { id: 'p-html', title: 'Semantic HTML', is_draft: false, extra: 'dropped' },
    { id: 'p-forms', title: 'Forms', is_draft: true },
  ],
  decks: [{ id: 's-css', title: 'CSS Layout', is_draft: false }],
};

// The quiz's links, in material order across both kinds. `s-file` is a FILE
// slide the classroom's options do not list.
const LINKED = [
  { kind: 'slide', id: 's-css', title: 'CSS Layout', is_draft: false, order: 0 },
  { kind: 'slide', id: 's-file', title: 'Lecture 3 PDF', is_draft: true, order: 1 },
  { kind: 'page', id: 'p-html', title: 'Semantic HTML', is_draft: false, order: 2 },
] as const;

const load = async (quizId?: string) =>
  (await loader({
    params: { class: CLASS_SLUG },
    request: new Request(
      `http://localhost/teacher/${CLASS_SLUG}/quizzes/form${quizId ? `?quizId=${quizId}` : ''}`
    ),
  } as unknown as Parameters<typeof loader>[0])) as Awaited<ReturnType<typeof loader>>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'teacher-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG },
  });
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.findByClassroomId.mockResolvedValue([]);
  mocks.listSourceMaterialOptions.mockResolvedValue(OFFERED);
  mocks.quizFindById.mockResolvedValue({
    id: 'quiz-1',
    classroom_id: 'class-1',
    name: 'Week 3',
    repository_id: null,
    system_prompt: null,
    rubric_prompt: 'r',
    status: 'DRAFT',
    weight: 0,
    source_material: LINKED,
    course_search_enabled: true,
  });
});

describe('picker values', () => {
  it('fromPickerValue inverts toPickerValue for both kinds', () => {
    expect(fromPickerValue(toPickerValue('page', 'p-html'))).toEqual({
      kind: 'page',
      id: 'p-html',
    });
    expect(fromPickerValue(toPickerValue('slide', 's-css'))).toEqual({
      kind: 'slide',
      id: 's-css',
    });
  });

  it('splits on the first colon only, so an id may contain one', () => {
    expect(fromPickerValue('page:a:b')).toEqual({ kind: 'page', id: 'a:b' });
  });

  it('keeps material order', () => {
    expect(toPickerValues(LINKED)).toEqual(['slide:s-css', 'slide:s-file', 'page:p-html']);
  });

  it('marks a draft in its label, as plain text', () => {
    expect(pickerLabel({ id: 'p', title: 'Forms', is_draft: true })).toBe('Forms — draft');
    expect(pickerLabel({ id: 'p', title: 'Forms', is_draft: false })).toBe('Forms');
  });
});

describe('pickerOptions: linked documents outside the options', () => {
  it('appends each to its own kind, after what the classroom offers', () => {
    const options = pickerOptions(OFFERED, LINKED);

    expect(options.pages.map(doc => doc.id)).toEqual(['p-html', 'p-forms']);
    expect(options.decks).toEqual([
      { id: 's-css', title: 'CSS Layout', is_draft: false },
      { id: 's-file', title: 'Lecture 3 PDF', is_draft: true },
    ]);
  });

  it('keeps only the fields the picker reads', () => {
    expect(pickerOptions(OFFERED, []).pages[0]).toEqual({
      id: 'p-html',
      title: 'Semantic HTML',
      is_draft: false,
    });
  });

  it('adds nothing when every linked document is offered', () => {
    const options = pickerOptions(OFFERED, [LINKED[0], LINKED[2]]);

    expect(options.pages).toHaveLength(2);
    expect(options.decks).toHaveLength(1);
  });
});

describe('the loader and submit, end to end', () => {
  it('an untouched edit writes back the list it read, in order', async () => {
    const data = await load('quiz-1');

    // What handleSubmit sends for the Select's values, unchanged.
    const submitted = (data.quiz!.sourceMaterial as string[]).map(fromPickerValue);

    expect(submitted).toEqual(LINKED.map(({ kind, id }) => ({ kind, id })));
    expect(data.quiz!.courseSearchEnabled).toBe(true);
  });

  it('gives every value the Select holds an option to name it, the outside slide included', async () => {
    const data = await load('quiz-1');

    const named = new Set([
      ...data.sourceMaterialOptions.pages.map(doc => toPickerValue('page', doc.id)),
      ...data.sourceMaterialOptions.decks.map(doc => toPickerValue('slide', doc.id)),
    ]);
    for (const value of data.quiz!.sourceMaterial as string[]) {
      expect(named.has(value as never)).toBe(true);
    }
    expect(data.sourceMaterialOptions.decks).toContainEqual({
      id: 's-file',
      title: 'Lecture 3 PDF',
      is_draft: true,
    });
  });

  it('a new quiz gets the offered options only', async () => {
    const data = await load();

    expect(data.quiz).toBeNull();
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(data.sourceMaterialOptions).toEqual(pickerOptions(OFFERED, []));
  });

  it("refuses another classroom's quiz before reading its material", async () => {
    mocks.quizFindById.mockResolvedValue({ id: 'quiz-9', classroom_id: 'class-2' });

    await expect(load('quiz-9')).rejects.toMatchObject({ status: 404 });
  });
});
