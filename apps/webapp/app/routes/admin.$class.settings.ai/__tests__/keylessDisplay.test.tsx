/**
 * The AI settings page, asserted against RENDERED MARKUP: without a classroom
 * key every select shows its platform default, never a stored value (the
 * ai-agent ignores stored values without a key), and every select is disabled.
 */

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  ClassroomSettingsEntitlementError: class extends Error {},
}));
vi.mock('~/utils/aiFeatures.server', () => ({ isAIAgentConfigured: () => true }));

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
];

const render = (
  hasKey: boolean,
  selectValues: Record<string, string | null>,
  aiAgentAvailable = true,
  extra: {
    settings?: Record<string, unknown>;
    quizzesProRequired?: boolean;
    askMojiProRequired?: boolean;
  } = {}
) => {
  const props = {
    loaderData: {
      organization: {
        settings: {
          has_anthropic_key: hasKey,
          quizzes_enabled: true,
          syllabus_bot_enabled: true,
          // What is stored. The page must not show it without a key.
          llm_model: 'claude-opus-5-5',
          ...extra.settings,
        },
      },
      availableModels: { anthropic: MODELS },
      quizModels: MODELS,
      aiAgentAvailable,
      quizzesProRequired: extra.quizzesProRequired ?? false,
      askMojiProRequired: extra.askMojiProRequired ?? false,
      defaultLabels: DEFAULT_LABELS,
      selectValues,
    },
  } as unknown as Parameters<typeof SettingsAI>[0];
  return renderToStaticMarkup(<SettingsAI {...props} />);
};

const ALL_NULL = Object.fromEntries(Object.keys(DEFAULT_LABELS).map(field => [field, null]));

describe('AI settings: keyless display', () => {
  it('shows every platform default and no stored choice without a key', () => {
    const html = render(false, ALL_NULL);

    for (const label of new Set(Object.values(DEFAULT_LABELS))) {
      expect(html).toContain(`Default: ${label}`);
    }
    expect(html.match(/ant-select-selection-placeholder/g)).toHaveLength(8);
    expect(html).not.toContain('ant-select-selection-item');
    expect(html).not.toContain('Claude Opus 5.5');
    expect(html.match(/ant-select-disabled/g)).toHaveLength(8);
    expect(html).toContain('Using system defaults');
  });

  it('shows the stored choice with a key', () => {
    const html = render(true, { ...ALL_NULL, llm_model: 'claude-opus-5-5' });

    expect(html).toContain('Claude Opus 5.5');
    expect(html.match(/ant-select-selection-placeholder/g)).toHaveLength(7);
    expect(html).not.toContain('ant-select-disabled');
    expect(html).toContain('Using classroom key');
  });
});

describe('AI settings: no AI agent on the server', () => {
  // Instructors read this; the env vars behind it are an operator's business.
  it('says AI features are unavailable, naming no env var', () => {
    const html = render(true, ALL_NULL, false);

    expect(html).toContain('AI features aren&#x27;t available on this server');
    expect(html).not.toContain('AI_AGENT');
  });

  it('shows nothing about it when the agent is configured', () => {
    expect(render(true, ALL_NULL)).not.toContain('available on this server');
  });
});

/** The page's two Enable switches, in page order: AI Quizzes, then Ask Moji. */
const switches = (html: string) =>
  [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(([tag]) => ({
    checked: tag.includes('aria-checked="true"'),
    disabled: /\sdisabled=""/.test(tag),
  }));

// The Enable switches show the EFFECTIVE state: without Pro the feature is off,
// whatever is stored, and the switch cannot change that. The stored flag is not
// rewritten; it applies again once the classroom is back on Pro.
describe('AI settings: Pro gating', () => {
  it('marks AI Quizzes and Ask Moji Pro, with no upsell on a Pro classroom', () => {
    const html = render(true, ALL_NULL);

    expect(html.match(/>Pro</g)).toHaveLength(2);
    expect(html).not.toContain('available on the Pro plan');
    expect(switches(html)).toEqual([
      { checked: true, disabled: false },
      { checked: true, disabled: false },
    ]);
  });

  it('shows the stored off on a Pro classroom, and lets it be turned on', () => {
    const html = render(false, ALL_NULL, true, {
      settings: { quizzes_enabled: false, syllabus_bot_enabled: false },
    });

    expect(switches(html)).toEqual([
      { checked: false, disabled: false },
      { checked: false, disabled: false },
    ]);
  });

  it('shows AI Quizzes off and disabled without Pro, even when stored on', () => {
    const html = render(true, ALL_NULL, true, {
      quizzesProRequired: true,
      settings: { quizzes_enabled: true },
    });

    expect(html).toContain('AI Quizzes is available on the Pro plan.');
    expect(html).toContain('href="/settings/billing"');
    expect(html).not.toContain('Ask Moji is available on the Pro plan.');
    expect(switches(html)).toEqual([
      { checked: false, disabled: true },
      { checked: true, disabled: false },
    ]);
  });

  it('shows Ask Moji off and disabled without Pro, even when stored on', () => {
    const html = render(true, ALL_NULL, true, {
      askMojiProRequired: true,
      settings: { syllabus_bot_enabled: true },
    });

    expect(html).toContain('Ask Moji is available on the Pro plan.');
    expect(html).not.toContain('AI Quizzes is available on the Pro plan.');
    expect(switches(html)).toEqual([
      { checked: true, disabled: false },
      { checked: false, disabled: true },
    ]);
  });

  it('shows both off and disabled without Pro when stored off', () => {
    const html = render(true, ALL_NULL, true, {
      quizzesProRequired: true,
      askMojiProRequired: true,
      settings: { quizzes_enabled: false, syllabus_bot_enabled: false },
    });

    expect(switches(html)).toEqual([
      { checked: false, disabled: true },
      { checked: false, disabled: true },
    ]);
  });

  // No settings row yet: quizzes_enabled unset is the schema's true, and
  // syllabus_bot_enabled unset is its false.
  it('reads unset flags as their schema defaults on a Pro classroom', () => {
    const html = render(true, ALL_NULL, true, {
      settings: { quizzes_enabled: undefined, syllabus_bot_enabled: undefined },
    });

    expect(switches(html)).toEqual([
      { checked: true, disabled: false },
      { checked: false, disabled: false },
    ]);
  });

  // A classroom's own key adds control, never access.
  it('keeps the gate for a classroom with its own key', () => {
    const html = render(true, ALL_NULL, true, {
      quizzesProRequired: true,
      askMojiProRequired: true,
    });

    expect(html).toContain('Using classroom key');
    expect(switches(html)).toEqual([
      { checked: false, disabled: true },
      { checked: false, disabled: true },
    ]);
  });
});

describe('AI settings: code exploration', () => {
  it('labels it with no billing copy', () => {
    const html = render(true, ALL_NULL);

    expect(html.match(/>Code exploration</g)).toHaveLength(2);
    expect(html).not.toMatch(/billed/i);
  });
});
