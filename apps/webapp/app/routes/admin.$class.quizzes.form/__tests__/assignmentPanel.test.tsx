// @vitest-environment jsdom
/**
 * The quiz form's Assignment panel, MOUNTED in jsdom (boards I1 and I3).
 *
 *   owner/teacher: the panel is editable (Module, Opens, Due, Closes with
 *                  "Close now", Weight, Published, "Students see it in"); the
 *                  quiz cannot be saved until a module is chosen. A module
 *                  card's "Add → Quiz" opens the form with its module chosen.
 *   no modules:    the owner is pointed at the modules page; a teacher is told
 *                  the owner has to add one. Save stays disabled either way.
 *   assistant:     the panel is read-only, as are the number of questions,
 *                  max attempts and grading strategy; the save carries none of
 *                  them, and there is no Delete.
 *   an edit:       sends only the panel fields changed in the form, so a form
 *                  opened before a change made elsewhere cannot undo it.
 *
 * And the loader that feeds it: the panel's values come from the quiz's
 * assignment (or, for a quiz in no module, from the quiz), a `?moduleId=`
 * preset only when it names a module of this class, and the quiz object itself
 * no longer carries a due date, status or weight.
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { quizAssignmentKeysIn, quizAuthorSettingKeysIn } from '@classmoji/utils';
import {
  changedPanelPayload,
  closesDateError,
  panelFormValues,
  panelPayload,
  panelStatus,
  studentsSeeItIn,
  type AssignmentPanelData,
} from '../QuizAssignmentPanel';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  pathname: '/admin/cs52-26f/quizzes/form',
  assertClassroomAccess: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  quizFindById: vi.fn(),
  findModules: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: { findByClassroomId: async () => [] },
    module: { findByClassroomSlug: (...a: unknown[]) => mocks.findModules(...a) },
    quizSourceMaterial: { listSourceMaterialOptions: async () => ({ pages: [], decks: [] }) },
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
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true, close: vi.fn() }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components/quiz/PromptAssistant', () => ({ PromptAssistant: () => null }));
vi.mock('react-router', () => ({
  useFetcher: () => ({ state: 'idle', data: undefined, submit: mocks.submit }),
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f' }),
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
}));
// The Drawer's portal and motion are not what is under test.
vi.mock('antd', async () => {
  const antd = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...antd,
    Drawer: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
      <div>
        {children}
        {footer}
      </div>
    ),
  };
});

// antd's Form.Item lays out with Row/Col, whose responsive observer needs it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
// A Form.Item showing a message (here, "Choose a module") reads its computed
// margin. jsdom's selector engine throws matching antd's
// `:has(> .ant-switch:only-child)` rule against an element whose class holds a
// colon (the drawer's Tailwind `lg:` classes); a browser does not. Layout is
// not under test, so such a read falls back to the body's style.
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
  try {
    return realGetComputedStyle(element, pseudo);
  } catch {
    return realGetComputedStyle(document.body);
  }
}) as typeof window.getComputedStyle;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizFormDrawer, loader } = await import('../route');

const CLASS_SLUG = 'cs52-26f';
const MODULES = [
  { id: 'mod-1', title: 'Week 1' },
  { id: 'mod-2', title: 'Week 2' },
];

const emptyPanel = (over: Partial<AssignmentPanelData> = {}): AssignmentPanelData => ({
  moduleId: null,
  moduleTitle: null,
  releaseAt: null,
  dueDate: null,
  closesAt: null,
  weight: 0,
  isPublished: false,
  ...over,
});

/** The quiz as the loader hands it to the form (no due date, status or weight). */
const formQuiz = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  name: 'Recursion check-in',
  repositoryId: null,
  systemPrompt: null,
  rubricPrompt: 'Grade the answers.',
  subject: 'Recursion',
  difficultyLevel: 'Beginner',
  questionCount: 5,
  maxAttempts: 1,
  gradingStrategy: 'HIGHEST',
  includeCodeContext: false,
  sourceMaterial: [],
  courseSearchEnabled: false,
  excludedPaths: '',
  ...over,
});

type Viewer = { canAuthor: boolean; isOwner: boolean };
const OWNER: Viewer = { canAuthor: true, isOwner: true };
const TEACHER: Viewer = { canAuthor: true, isOwner: false };
const ASSISTANT: Viewer = { canAuthor: false, isOwner: false };

let container: HTMLDivElement;
let root: Root;

const render = async ({
  viewer,
  quiz = null,
  modules = MODULES,
  panel = emptyPanel(),
}: {
  viewer: Viewer;
  quiz?: Record<string, unknown> | null;
  modules?: Array<{ id: string; title: string }>;
  panel?: AssignmentPanelData;
}) => {
  await act(async () => {
    root.render(
      <QuizFormDrawer
        {...({
          loaderData: {
            org: CLASS_SLUG,
            quiz,
            isEditing: Boolean(quiz),
            assignments: [],
            examplePrompts: [],
            sourceMaterialOptions: { pages: [], decks: [] },
            ...viewer,
            modules,
            assignmentPanel: panel,
          },
        } as unknown as Parameters<typeof QuizFormDrawer>[0])}
      />
    );
  });
};

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const saveButton = () => byTestId('quiz-form-save') as HTMLButtonElement;
const editablePanel = () => byTestId('quiz-assignment-panel');
const readOnlyPanel = () => byTestId('quiz-assignment-panel-readonly');
const deleteButton = () =>
  [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Delete');
const chosenModule = () =>
  editablePanel()?.querySelector('.ant-select-selection-item')?.textContent ?? null;
const chips = () =>
  [...(byTestId('quiz-students-see-it-in')?.querySelectorAll('span') ?? [])].map(
    s => s.textContent
  );

/** Type into an input or textarea the way React sees a user do it. */
const type = async (selector: string, text: string) => {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
};

/** Fill the fields a new quiz requires besides its module. */
const fillRequired = async () => {
  await type('input#name', 'Recursion check-in');
  await type('input#subject', 'Recursion');
  await type('textarea#rubricPrompt', 'Full credit for a correct base case.');
};

beforeEach(() => {
  mocks.submit.mockReset();
  mocks.pathname = '/admin/cs52-26f/quizzes/form';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the owner or a teacher creating a quiz', () => {
  it('cannot save until a module is chosen, and is asked to choose one', async () => {
    await render({ viewer: OWNER });

    expect(editablePanel()).not.toBeNull();
    expect(readOnlyPanel()).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe('Create');
    expect(chosenModule()).toBeNull();
    expect(editablePanel()!.textContent).toContain('Choose a module');

    await fillRequired();
    await click(saveButton());
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('opened from a module card, starts in that module and can save', async () => {
    await render({
      viewer: TEACHER,
      panel: emptyPanel({ moduleId: 'mod-2', moduleTitle: 'Week 2' }),
    });

    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(chosenModule()).toBe('Week 2');
    expect(editablePanel()!.querySelector('.ant-form-item-explain')).toBeNull();

    await fillRequired();
    await click(saveButton());

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload, options] = mocks.submit.mock.calls[0];
    expect(payload).toMatchObject({
      _action: 'createQuiz',
      name: 'Recursion check-in',
      assignment: {
        moduleId: 'mod-2',
        releaseAt: null,
        dueDate: null,
        closesAt: null,
        weight: 0,
        isPublished: false,
      },
    });
    expect(options).toMatchObject({ method: 'POST', action: `/admin/${CLASS_SLUG}/quizzes` });
  });

  it('offers Module, Opens, Due, Closes with Close now, Weight and Published', async () => {
    await render({ viewer: OWNER });

    const text = editablePanel()!.textContent!;
    for (const label of ['Module', 'Opens', 'Due', 'Closes', 'Close now', 'Weight', 'Published']) {
      expect(text).toContain(label);
    }
    expect(byTestId('quiz-close-now')).not.toBeNull();
    expect(byTestId('quiz-published-switch')).not.toBeNull();
    // Nothing students see while the quiz is unpublished.
    expect(byTestId('quiz-students-see-it-in')).toBeNull();
  });
});

describe('editing a quiz as the owner or a teacher', () => {
  const assigned = emptyPanel({
    moduleId: 'mod-1',
    moduleTitle: 'Week 1',
    dueDate: '2026-10-09T16:00:00.000Z',
    weight: 10,
    isPublished: true,
  });

  it('shows where students see it, and an unchanged panel sends nothing with the save', async () => {
    await render({ viewer: TEACHER, quiz: formQuiz(), panel: assigned });

    expect(chosenModule()).toBe('Week 1');
    expect(chips()).toEqual(['Assignments', 'Week 1', 'Calendar', 'Dashboard', 'Grades']);
    expect(deleteButton()).toBeDefined();

    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    await type('input#name', 'Recursion check-in, revised');
    await click(saveButton());

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload] = mocks.submit.mock.calls[0];
    expect(payload).toMatchObject({
      _action: 'updateQuiz',
      id: 'quiz-1',
      name: 'Recursion check-in, revised',
    });
    // Published, due date and weight stay as whoever set them last left them.
    expect(payload).not.toHaveProperty('assignment');
    expect(quizAssignmentKeysIn(payload)).toEqual([]);
  });

  it('sends only the panel field that was changed', async () => {
    await render({ viewer: OWNER, quiz: formQuiz(), panel: assigned });

    await type('.ant-input-number input', '15');
    await click(saveButton());

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0].assignment).toEqual({ weight: 15 });
  });

  it('Close now sets Closes to now, and the save carries it, even before Due', async () => {
    // Due is still ahead: closing a quiz early is allowed.
    const dueAhead = emptyPanel({ ...assigned, dueDate: dayjs().add(7, 'day').toISOString() });
    await render({ viewer: OWNER, quiz: formQuiz(), panel: dueAhead });
    expect(byTestId('quiz-assignment-status')?.textContent).toContain('Published');

    const before = Date.now();
    await click(byTestId('quiz-close-now')!);
    expect(byTestId('quiz-assignment-status')?.textContent).toBe('Closed');
    expect(editablePanel()!.textContent).not.toContain('can’t be before');
    expect(saveButton().disabled).toBe(false);

    await click(saveButton());
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const sent = mocks.submit.mock.calls[0][0].assignment;
    expect(Object.keys(sent)).toEqual(['closesAt']);
    const closesAt = Date.parse(sent.closesAt);
    expect(closesAt).toBeGreaterThanOrEqual(before - 1000);
    expect(closesAt).toBeLessThanOrEqual(Date.now());
  });

  it('refuses Close now on a quiz that opens later: an inline error, and Save is disabled', async () => {
    await render({
      viewer: OWNER,
      quiz: formQuiz(),
      panel: emptyPanel({ ...assigned, releaseAt: dayjs().add(7, 'day').toISOString() }),
    });
    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));

    // Opens is next week; closing now comes before it.
    await click(byTestId('quiz-close-now')!);

    expect(editablePanel()!.textContent).toContain('Closes can’t be before Opens');
    expect(saveButton().disabled).toBe(true);
    await click(saveButton());
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('does not hold up a content save over dates it did not change', async () => {
    // Saved before the rule: closes before it opens.
    await render({
      viewer: OWNER,
      quiz: formQuiz(),
      panel: emptyPanel({
        ...assigned,
        releaseAt: '2026-10-05T16:00:00.000Z',
        closesAt: '2026-10-01T16:00:00.000Z',
      }),
    });

    await vi.waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(editablePanel()!.textContent).not.toContain('can’t be before');
  });

  it('reads Scheduled with the Opens date, and lists nowhere students see it yet', async () => {
    await render({
      viewer: OWNER,
      quiz: formQuiz(),
      panel: emptyPanel({ ...assigned, releaseAt: dayjs().add(7, 'day').toISOString() }),
    });

    expect(byTestId('quiz-assignment-status')?.textContent).toMatch(/^Scheduled · /);
    expect(byTestId('quiz-students-see-it-in')).toBeNull();
  });

  it('asks before Delete, saying the quiz leaves its module, and deletes on Delete', async () => {
    await render({ viewer: OWNER, quiz: formQuiz(), panel: assigned });

    await click(deleteButton()!);
    expect(mocks.submit).not.toHaveBeenCalled();
    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('.ant-modal-confirm');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(dialog.textContent).toContain('Delete quiz');
    expect(dialog.textContent).toContain(
      'This deletes the quiz and every attempt at it, and removes it from Week 1.'
    );

    const confirm = [...dialog.querySelectorAll('button')].find(
      b => b.textContent?.trim() === 'Delete'
    )!;
    await click(confirm);
    await vi.waitFor(() =>
      expect(mocks.submit).toHaveBeenCalledWith(
        { _action: 'deleteQuiz', id: 'quiz-1' },
        expect.objectContaining({ method: 'POST', action: `/admin/${CLASS_SLUG}/quizzes` })
      )
    );
  });

  it('puts the panel before the quiz fields in the page, and last on a wide screen', async () => {
    await render({ viewer: OWNER, quiz: formQuiz(), panel: assigned });

    const name = container.querySelector('input#name')!;
    expect(
      editablePanel()!.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(editablePanel()!.parentElement!.className).toContain('lg:order-last');
  });
});

describe('a class with no modules', () => {
  it('points the owner at the modules page, and Save stays disabled', async () => {
    await render({ viewer: OWNER, modules: [] });

    const note = byTestId('quiz-no-modules-note')!;
    expect(note).not.toBeNull();
    const link = note.querySelector('a');
    expect(link?.getAttribute('href')).toBe(`/admin/${CLASS_SLUG}/modules`);
    expect(link?.textContent).toBe('Add a module');
    // A new tab, so the quiz being written here is not lost.
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
    expect(saveButton().disabled).toBe(true);
    // No module to choose from.
    expect(editablePanel()!.querySelector('.ant-select')).toBeNull();
  });

  it('tells a teacher the class owner has to add one, with no link, and Save stays disabled', async () => {
    mocks.pathname = '/teacher/cs52-26f/quizzes/form';
    await render({ viewer: TEACHER, modules: [] });

    const note = byTestId('quiz-no-modules-note')!;
    expect(note.textContent).toBe(
      'A quiz lives in a module. The class owner has to add a module before a quiz can be saved.'
    );
    expect(note.querySelector('a')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });
});

describe('a teaching assistant', () => {
  const panel = emptyPanel({
    moduleId: 'mod-1',
    moduleTitle: 'Week 1',
    dueDate: '2026-10-09T16:00:00.000Z',
    weight: 10,
    isPublished: true,
  });

  beforeEach(() => {
    mocks.pathname = '/assistant/cs52-26f/quizzes/form';
  });

  it('sees the panel read-only, with no Delete', async () => {
    await render({ viewer: ASSISTANT, quiz: formQuiz(), panel });

    expect(readOnlyPanel()).not.toBeNull();
    expect(editablePanel()).toBeNull();
    expect(byTestId('quiz-close-now')).toBeNull();
    expect(byTestId('quiz-published-switch')).toBeNull();
    expect(readOnlyPanel()!.querySelector('input, button, .ant-select')).toBeNull();
    const text = readOnlyPanel()!.textContent!;
    expect(text).toContain('Week 1');
    expect(text).toContain('Yes');
    expect(chips()).toEqual(['Assignments', 'Week 1', 'Calendar', 'Dashboard', 'Grades']);
    expect(deleteButton()).toBeUndefined();
  });

  it('saves the content only: no assignment field in the save', async () => {
    await render({ viewer: ASSISTANT, quiz: formQuiz(), panel });

    expect(saveButton().disabled).toBe(false);
    await type('input#name', 'Recursion check-in, revised');
    await click(saveButton());

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload, options] = mocks.submit.mock.calls[0];
    expect(payload).toMatchObject({
      _action: 'updateQuiz',
      id: 'quiz-1',
      name: 'Recursion check-in, revised',
    });
    expect(payload).not.toHaveProperty('assignment');
    expect(quizAssignmentKeysIn(payload)).toEqual([]);
    // Nor the number of questions, max attempts or grading strategy.
    expect(quizAuthorSettingKeysIn(payload)).toEqual([]);
    expect(options).toMatchObject({ action: `/assistant/${CLASS_SLUG}/quizzes` });
  });

  it('sees the number of questions, max attempts and grading strategy read-only', async () => {
    await render({ viewer: ASSISTANT, quiz: formQuiz(), panel });

    expect((byTestId('quiz-question-count') as HTMLInputElement).disabled).toBe(true);
    expect((byTestId('quiz-max-attempts') as HTMLInputElement).disabled).toBe(true);
    expect(
      container.querySelector(
        '.ant-select-disabled[data-testid="quiz-grading-strategy"], [data-testid="quiz-grading-strategy"].ant-select-disabled'
      )
    ).not.toBeNull();
  });

  it('can save a quiz that is in no module', async () => {
    await render({ viewer: ASSISTANT, quiz: formQuiz(), panel: emptyPanel() });

    expect(readOnlyPanel()!.textContent).toContain(
      "The class owner or a teacher chooses this quiz's module."
    );
    expect(saveButton().disabled).toBe(false);
  });
});

// ─── The loader ─────────────────────────────────────────────────────────────

describe('the loader', () => {
  const load = async (query = '', role = 'OWNER') => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'user-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG },
      membership: { role },
    });
    return (await loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/quizzes/form${query}`),
    } as unknown as Parameters<typeof loader>[0])) as Awaited<ReturnType<typeof loader>>;
  };

  /** A quiz as quiz.findById returns it, with flat columns that disagree with its assignment. */
  const storedQuiz = (over: Record<string, unknown> = {}) => ({
    id: 'quiz-1',
    classroom_id: 'class-1',
    name: 'Recursion',
    repository_id: null,
    system_prompt: null,
    rubric_prompt: 'r',
    subject: 'Recursion',
    difficulty_level: 'Beginner',
    question_count: 5,
    max_attempts: 1,
    grading_strategy: 'HIGHEST',
    include_code_context: false,
    source_material: [],
    course_search_enabled: false,
    excluded_paths: [],
    status: 'DRAFT',
    weight: 99,
    due_date: new Date('2026-12-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-20T12:00:00.000Z'),
    assignment: null,
    ...over,
  });

  beforeEach(() => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
    mocks.findModules.mockResolvedValue([
      { id: 'mod-1', title: 'Week 1', slug: 'week-1', position: 0, description: 'x' },
      { id: 'mod-2', title: 'Week 2', slug: 'week-2', position: 1, description: 'y' },
    ]);
    mocks.quizFindById.mockReset();
  });

  it("lists the class's modules as id and title", async () => {
    const data = await load();

    expect(mocks.findModules).toHaveBeenCalledWith(CLASS_SLUG);
    expect(data.modules).toEqual(MODULES);
  });

  it('presets a new quiz to the module named by ?moduleId', async () => {
    const data = await load('?moduleId=mod-2');

    expect(data.assignmentPanel).toEqual(emptyPanel({ moduleId: 'mod-2', moduleTitle: 'Week 2' }));
  });

  it('ignores a ?moduleId that is not a module of this class', async () => {
    const data = await load('?moduleId=mod-of-another-class');

    expect(data.assignmentPanel).toEqual(emptyPanel());
  });

  it("takes an assigned quiz's panel values from its assignment", async () => {
    mocks.quizFindById.mockResolvedValue(
      storedQuiz({
        assignment: {
          module_id: 'mod-1',
          module: { title: 'Week 1' },
          release_at: new Date('2026-10-05T13:00:00.000Z'),
          student_deadline: new Date('2026-10-09T16:00:00.000Z'),
          closes_at: new Date('2026-10-10T16:00:00.000Z'),
          weight: 12.5,
          is_published: true,
        },
      })
    );

    const data = await load('?quizId=quiz-1&moduleId=mod-2');

    expect(data.assignmentPanel).toEqual({
      moduleId: 'mod-1',
      moduleTitle: 'Week 1',
      releaseAt: '2026-10-05T13:00:00.000Z',
      dueDate: '2026-10-09T16:00:00.000Z',
      closesAt: '2026-10-10T16:00:00.000Z',
      weight: 12.5,
      isPublished: true,
    });
  });

  it('gives a closed quiz in no module its last update as its close date', async () => {
    mocks.quizFindById.mockResolvedValue(storedQuiz({ status: 'CLOSED', weight: 5 }));

    const data = await load('?quizId=quiz-1');

    expect(data.assignmentPanel).toEqual({
      moduleId: null,
      moduleTitle: null,
      releaseAt: null,
      dueDate: '2026-12-01T00:00:00.000Z',
      closesAt: '2026-09-20T12:00:00.000Z',
      weight: 5,
      isPublished: true,
    });
  });

  it('gives a draft quiz in no module no close date, unpublished', async () => {
    mocks.quizFindById.mockResolvedValue(storedQuiz({ due_date: null }));

    const data = await load('?quizId=quiz-1');

    expect(data.assignmentPanel).toMatchObject({
      moduleId: null,
      dueDate: null,
      closesAt: null,
      isPublished: false,
    });
  });

  it('hands the form a quiz with no due date, status or weight of its own', async () => {
    mocks.quizFindById.mockResolvedValue(storedQuiz());

    const { quiz } = await load('?quizId=quiz-1');

    expect(quiz).not.toBeNull();
    for (const key of ['dueDate', 'due_date', 'status', 'weight', 'assignment']) {
      expect(quiz).not.toHaveProperty(key);
    }
  });

  it.each([
    ['OWNER', true, true],
    ['TEACHER', true, false],
    ['ASSISTANT', false, false],
  ])('%s: canAuthor %s, isOwner %s', async (role, canAuthor, isOwner) => {
    mocks.quizFindById.mockResolvedValue(storedQuiz());
    const data = await load('?quizId=quiz-1', role);

    expect(data.canAuthor).toBe(canAuthor);
    expect(data.isOwner).toBe(isOwner);
  });

  it('sends an assistant who opens the form with no quiz back to the quiz list', async () => {
    mocks.findModules.mockClear();
    const thrown = await load('', 'ASSISTANT').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get('Location')).toBe(`/admin/${CLASS_SLUG}/quizzes`);
    expect(mocks.findModules).not.toHaveBeenCalled();
  });
});

// ─── The panel's helpers ────────────────────────────────────────────────────

describe('panelPayload', () => {
  it('sends an untouched panel as no module, no dates, weight 0, unpublished', () => {
    expect(panelPayload(undefined)).toEqual({
      moduleId: null,
      releaseAt: null,
      dueDate: null,
      closesAt: null,
      weight: 0,
      isPublished: false,
    });
  });

  it('sends dates as ISO strings and the weight as a number', () => {
    expect(
      panelPayload({
        moduleId: 'mod-1',
        releaseAt: dayjs('2026-10-05T13:00:00.000Z'),
        dueDate: dayjs('2026-10-09T16:00:00.000Z'),
        closesAt: null,
        weight: '7' as unknown as number,
        isPublished: true,
      })
    ).toEqual({
      moduleId: 'mod-1',
      releaseAt: '2026-10-05T13:00:00.000Z',
      dueDate: '2026-10-09T16:00:00.000Z',
      closesAt: null,
      weight: 7,
      isPublished: true,
    });
  });

  it('sends a cleared weight as 0, and only a true switch as published', () => {
    expect(panelPayload({ moduleId: 'mod-1', weight: null })).toMatchObject({
      weight: 0,
      isPublished: false,
    });
  });

  it('round-trips what the loader sent', () => {
    const data = emptyPanel({
      moduleId: 'mod-1',
      moduleTitle: 'Week 1',
      releaseAt: '2026-10-05T13:00:00.000Z',
      dueDate: '2026-10-09T16:00:00.000Z',
      closesAt: '2026-10-10T16:00:00.000Z',
      weight: 12.5,
      isPublished: true,
    });

    const { moduleTitle: _title, ...expected } = data;
    expect(panelPayload(panelFormValues(data))).toEqual(expected);
  });
});

describe('studentsSeeItIn', () => {
  const published = { isPublished: true, moduleTitle: 'Week 1', hasDueDate: true, weight: 10 };

  it('is nothing while the quiz is unpublished', () => {
    expect(studentsSeeItIn({ ...published, isPublished: false })).toEqual([]);
  });

  it('lists Assignments, the module, Calendar, Dashboard and Grades for a published, due, weighted quiz', () => {
    expect(studentsSeeItIn(published)).toEqual([
      'Assignments',
      'Week 1',
      'Calendar',
      'Dashboard',
      'Grades',
    ]);
  });

  it('lists Calendar only with a due date', () => {
    expect(studentsSeeItIn({ ...published, hasDueDate: false })).not.toContain('Calendar');
  });

  it('lists Grades only when the weight is above 0', () => {
    expect(studentsSeeItIn({ ...published, weight: 0 })).not.toContain('Grades');
  });

  it('is nothing until the quiz opens', () => {
    const now = dayjs('2026-10-02T12:00:00Z');
    expect(studentsSeeItIn({ ...published, releaseAt: '2026-10-09T13:00:00Z', now })).toEqual([]);
    expect(studentsSeeItIn({ ...published, releaseAt: '2026-10-01T13:00:00Z', now })).toContain(
      'Assignments'
    );
  });

  it('lists Assignments and Dashboard for a published quiz with nothing else set', () => {
    expect(
      studentsSeeItIn({ isPublished: true, moduleTitle: null, hasDueDate: false, weight: 0 })
    ).toEqual(['Assignments', 'Dashboard']);
  });
});

describe('changedPanelPayload', () => {
  const loaded = emptyPanel({
    moduleId: 'mod-1',
    moduleTitle: 'Week 1',
    releaseAt: '2026-10-05T13:00:00.000Z',
    dueDate: '2026-10-09T16:00:00.000Z',
    weight: 10,
    isPublished: false,
  });

  it('is empty for the panel as the loader sent it', () => {
    expect(changedPanelPayload(panelFormValues(loaded), loaded)).toEqual({});
  });

  it('names each field that changed, and nothing else', () => {
    expect(
      changedPanelPayload(
        { ...panelFormValues(loaded), dueDate: null, isPublished: true, moduleId: 'mod-2' },
        loaded
      )
    ).toEqual({ dueDate: null, isPublished: true, moduleId: 'mod-2' });
  });

  it('reads a date at the same instant as unchanged, whatever its spelling', () => {
    expect(
      changedPanelPayload(
        { ...panelFormValues(loaded), dueDate: dayjs('2026-10-09T12:00:00-04:00') },
        loaded
      )
    ).toEqual({});
  });
});

describe('closesDateError', () => {
  it('refuses Closes before Opens', () => {
    expect(
      closesDateError({ releaseAt: '2026-10-05T00:00:00Z', closesAt: '2026-10-04T00:00:00Z' })
    ).toBe('Closes can’t be before Opens');
  });

  it('takes Closes on or after Opens, with no Opens, or no Closes at all', () => {
    const releaseAt = '2026-10-05T00:00:00Z';
    expect(closesDateError({ releaseAt, closesAt: '2026-10-05T00:00:00Z' })).toBeNull();
    expect(closesDateError({ releaseAt, closesAt: '2026-10-06T00:00:00Z' })).toBeNull();
    expect(closesDateError({ releaseAt: null, closesAt: '2026-10-01T00:00:00Z' })).toBeNull();
    expect(closesDateError({ releaseAt, closesAt: null })).toBeNull();
  });
});

describe('panelStatus', () => {
  const now = dayjs('2026-10-02T12:00:00Z');

  it('reads Draft, Scheduled with its date, Published and Closed', () => {
    expect(panelStatus(false, null, null, now)).toBe('Draft');
    expect(panelStatus(true, null, '2026-10-09T13:00:00Z', now)).toMatch(
      /^Scheduled · Fri Oct 9 · /
    );
    expect(panelStatus(true, null, '2026-10-01T13:00:00Z', now)).toBe('Published');
    expect(panelStatus(true, '2026-10-02T11:00:00Z', null, now)).toBe('Closed');
  });
});
