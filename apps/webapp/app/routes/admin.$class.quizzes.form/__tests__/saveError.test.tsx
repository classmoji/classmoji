/**
 * The quiz form drawer and a refused save.
 *
 * The drawer submits to the quizzes list route's action, which RETURNS its
 * refusals as `{ error }` (a 404 "Some of the source material is not in this
 * class", a 409 when another save of the same material committed first, a 404
 * for a quiz that is gone). Only a success closes the drawer, so a refusal
 * leaves it open, and it must say why there — before this it said nothing and
 * the Update button simply stopped spinning.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetcher = vi.hoisted(() => ({
  state: 'idle' as string,
  data: undefined as unknown,
  submit: () => {},
}));

vi.mock('@classmoji/services', () => ({ ClassmojiService: {}, getExamplePrompts: () => [] }));
vi.mock('~/utils/helpers', () => ({ assertClassroomAccess: vi.fn() }));
vi.mock('~/utils/classroomProFlag.server', () => ({ quizzesVisibleOrThrow: vi.fn() }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true, close: vi.fn() }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('~/components/quiz/PromptAssistant', () => ({ PromptAssistant: () => null }));
vi.mock('react-router', () => ({
  useFetcher: () => fetcher,
  useLocation: () => ({ pathname: '/teacher/cs52-26f/quizzes/form' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f' }),
}));
// antd's Drawer renders into a portal, which static markup never reaches.
vi.mock('antd', async () => {
  const antd = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...antd,
    Drawer: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
      <div>
        {children}
        {footer}
      </div>
    ),
  };
});

const { default: QuizFormDrawer } = await import('../route');

const NOT_IN_CLASS = 'Some of the source material is not in this class';

const render = () =>
  renderToStaticMarkup(
    <QuizFormDrawer
      {...({
        loaderData: {
          org: 'cs52-26f',
          quiz: null,
          isEditing: false,
          assignments: [],
          examplePrompts: [],
          sourceMaterialOptions: { pages: [], decks: [] },
          canAuthor: true,
          isOwner: true,
          modules: [{ id: 'mod-1', title: 'Week 1' }],
          assignmentPanel: {
            moduleId: 'mod-1',
            moduleTitle: 'Week 1',
            releaseAt: null,
            dueDate: null,
            closesAt: null,
            weight: 0,
            isPublished: false,
          },
        },
      } as unknown as Parameters<typeof QuizFormDrawer>[0])}
    />
  );

beforeEach(() => {
  fetcher.state = 'idle';
  fetcher.data = undefined;
});

describe('the quiz form drawer after a refused save', () => {
  it('shows the refusal', () => {
    fetcher.data = { error: NOT_IN_CLASS };

    const html = render();

    expect(html).toContain(NOT_IN_CLASS);
    expect(html).toContain('ant-alert-error');
  });

  it('shows the conflict refusal the same way', () => {
    const conflict =
      "Someone else saved this quiz's source material at the same time. Reload and save again.";
    fetcher.data = { error: conflict };

    expect(render()).toContain('Someone else saved this quiz&#x27;s source material');
  });

  it('shows a refused assignment write the same way', () => {
    fetcher.data = { error: 'Module not found in this classroom' };

    const html = render();

    expect(html).toContain('Module not found in this classroom');
    expect(html).toContain('ant-alert-error');
  });

  it('shows nothing while the next save is on its way', () => {
    fetcher.state = 'submitting';
    fetcher.data = { error: NOT_IN_CLASS };

    expect(render()).not.toContain(NOT_IN_CLASS);
  });

  it('shows nothing after a successful save', () => {
    fetcher.data = { success: 'Quiz updated successfully' };

    expect(render()).not.toContain('ant-alert');
  });
});
