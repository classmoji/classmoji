// @vitest-environment jsdom
/**
 * The AI settings form across a key change, MOUNTED in jsdom (the static
 * markup tests cannot see this: it only happens on a client rerender).
 *
 * The form remounts when the classroom's key comes or goes, because the
 * selects switch between the stored values (key) and the platform defaults (no
 * key). A form store that outlives the remount keeps the old values over the
 * new initialValues, so:
 *   - after "Clear all AI settings" the disabled selects still show the old
 *     choices instead of the defaults;
 *   - when a keyless classroom with stored choices adds a key, the selects show
 *     placeholders and the next Save nulls every stored choice.
 *
 * Also: without a key the AI Quizzes and Ask Moji Save buttons are disabled
 * (their selects are, and a Save would send nothing); the API Key Save is not.
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.fn();

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useParams: () => ({ class: 'cs52' }),
}));
vi.mock('~/components', () => ({
  SettingSection: ({
    title,
    extra,
    children,
  }: {
    title: ReactNode;
    extra?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      {extra}
      {children}
    </section>
  ),
}));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: { submit } }) }));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  ClassroomSettingsEntitlementError: class extends Error {},
}));
vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));

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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SettingsAI } = await import('../route');

const DEFAULT_LABELS = {
  llm_model: 'Claude Sonnet 4.5',
  code_aware_model: 'Claude Sonnet 4.5',
  exploration_model: 'Claude Sonnet 5',
  syllabus_bot_model: 'Claude Sonnet 4.5',
  question_effort: 'Medium',
  grading_effort: 'High',
  exploration_effort: 'Low',
  syllabus_bot_effort: 'Low',
};

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

/** A choice in every select, none of them a default. */
const STORED = {
  llm_model: 'claude-opus-5-5',
  code_aware_model: 'claude-opus-5-5',
  exploration_model: 'claude-haiku-4-5-20251001',
  syllabus_bot_model: 'claude-sonnet-5',
  question_effort: 'high',
  grading_effort: 'max',
  exploration_effort: 'medium',
  syllabus_bot_effort: 'xhigh',
};

/** The labels the selects show for STORED, in page order. */
const STORED_LABELS = [
  'Claude Opus 5.5',
  'Claude Opus 5.5',
  'Claude Haiku 4.5',
  'High',
  'Max',
  'Medium',
  'Claude Sonnet 5',
  'Extra high (xhigh)',
];

const ALL_NULL = Object.fromEntries(Object.keys(STORED).map(field => [field, null]));

/** Loader data as the loader returns it, with or without a classroom key. */
const loaderData = (hasKey: boolean) =>
  ({
    loaderData: {
      organization: {
        settings: {
          has_anthropic_key: hasKey,
          quizzes_enabled: true,
          syllabus_bot_enabled: true,
          ...(hasKey ? STORED : ALL_NULL),
        },
      },
      availableModels: { anthropic: MODELS },
      aiAgentAvailable: true,
      askMojiProRequired: false,
      defaultLabels: DEFAULT_LABELS,
      selectValues: hasKey ? STORED : ALL_NULL,
    },
  }) as unknown as Parameters<typeof SettingsAI>[0];

let container: HTMLDivElement;
let root: Root;

const render = async (hasKey: boolean) => {
  await act(async () => {
    root.render(<SettingsAI {...loaderData(hasKey)} />);
  });
};

const selected = () =>
  [...container.querySelectorAll('.ant-select-selection-item')].map(node => node.textContent);
const placeholders = () =>
  [...container.querySelectorAll('.ant-select-selection-placeholder')].map(
    node => node.textContent
  );
const saveButtons = () =>
  [...container.querySelectorAll('button')].filter(button => button.textContent === 'Save');

beforeEach(() => {
  submit.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('AI settings form: the key comes or goes', () => {
  it('shows the defaults after Clear all AI settings, not the old choices', async () => {
    await render(true);
    expect(selected()).toEqual(STORED_LABELS);

    // Clear all AI settings: the key and every choice are gone.
    await render(false);

    expect(selected()).toEqual([]);
    expect(placeholders()).toHaveLength(8);
    expect(new Set(placeholders())).toEqual(
      new Set(Object.values(DEFAULT_LABELS).map(label => `Default: ${label}`))
    );
  });

  it('shows the stored choices once a key is added, and Save keeps them', async () => {
    await render(false);
    expect(selected()).toEqual([]);

    // The key is saved; the loader now returns the stored choices.
    await render(true);
    expect(selected()).toEqual(STORED_LABELS);

    const quizzesSave = saveButtons()[1];
    await act(async () => {
      quizzesSave.click();
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

    const [payload] = submit.mock.calls[0];
    expect(payload).toEqual({ _action: 'saveLLMSettings', anthropic_api_key: '', ...STORED });
  });
});

describe('AI settings form: Save buttons', () => {
  it('disables the AI Quizzes and Ask Moji Save without a key, not the API Key Save', async () => {
    await render(false);
    expect(saveButtons().map(button => button.disabled)).toEqual([false, true, true]);
  });

  it('enables every Save with a key', async () => {
    await render(true);
    expect(saveButtons().map(button => button.disabled)).toEqual([false, false, false]);
  });
});
