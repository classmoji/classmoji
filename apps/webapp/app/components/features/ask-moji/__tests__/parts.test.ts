import { describe, expect, it } from 'vitest';
import type { AskMojiUIMessage } from '@classmoji/utils/ask-moji';
import { sourceChipsOf, stepsOf } from '../parts';

const ctx = {
  classroomSlug: 'cs1',
  pagesUrl: 'https://pages.classmoji.io',
  slidesUrl: 'https://slides.classmoji.io',
};

const msg = (parts: unknown[]) => ({ parts }) as unknown as AskMojiUIMessage;

const cite = (state: string, output: unknown, input: unknown = {}) => ({
  type: 'tool-cite_content',
  toolCallId: `call-${Math.random()}`,
  state,
  input,
  output,
});

describe('source chips', () => {
  it('come only from output-available cites that say ok: true', () => {
    const chips = sourceChipsOf(
      msg([
        cite('output-available', { ok: true, type: 'page', id: 'p1', title: 'Syllabus' }),
        cite('output-available', { ok: false, type: 'page', id: 'p2', title: 'Draft' }),
        cite('input-available', undefined, { type: 'page', id: 'p3' }),
        cite('input-streaming', undefined, { type: 'page', id: 'p4' }),
        cite('output-error', undefined, { type: 'page', id: 'p5' }),
        { type: 'text', text: 'See [Week 9](content://p9)' },
      ]),
      ctx
    );
    expect(chips).toEqual([
      {
        key: 'page:p1',
        type: 'page',
        title: 'Syllabus',
        url: 'https://pages.classmoji.io/cs1/p1',
      },
    ]);
  });

  it('use the server’s title, never the model’s input', () => {
    const [chip] = sourceChipsOf(
      msg([
        cite(
          'output-available',
          { ok: true, type: 'slides', id: 'd1', title: 'Lecture 3' },
          { type: 'slides', id: 'd1', title: 'Made-up title' }
        ),
      ]),
      ctx
    );
    expect(chip.title).toBe('Lecture 3');
    expect(chip.url).toBe('https://slides.classmoji.io/d1');
  });

  it('a docs path goes through the shared helper; a missing link is a label', () => {
    const chips = sourceChipsOf(
      msg([
        cite('output-available', {
          ok: true,
          type: 'platform_docs',
          path: 'docs/students/tokens',
          title: 'Tokens',
        }),
        cite('output-available', { ok: true, type: 'page', id: 'p1', title: 'No pages app' }),
      ]),
      { ...ctx, pagesUrl: null }
    );
    expect(chips[0].url).toContain('docs/students/tokens');
    expect(chips[1].url).toBeNull();
  });

  it('production without PAGES_URL / SLIDES_URL (null): page and deck chips are labels, or the server’s http(s) url', () => {
    const chips = sourceChipsOf(
      msg([
        cite('output-available', { ok: true, type: 'page', id: 'p1', title: 'Page' }),
        cite('output-available', { ok: true, type: 'slides', id: 'd1', title: 'Deck' }),
        cite('output-available', {
          ok: true,
          type: 'slides',
          id: 'd2',
          title: 'Linked deck',
          url: 'https://slides.example.org/d2',
        }),
      ]),
      { ...ctx, pagesUrl: null, slidesUrl: null }
    );
    expect(chips.map(c => c.url)).toEqual([null, null, 'https://slides.example.org/d2']);
    expect(JSON.stringify(chips)).not.toContain('localhost');
  });

  it('dedupe by target, skip untitled ones, and only accept an http(s) server url as a fallback', () => {
    const chips = sourceChipsOf(
      msg([
        cite('output-available', { ok: true, type: 'page', id: 'p1', title: 'A' }),
        cite('output-available', { ok: true, type: 'page', id: 'p1', title: 'A again' }),
        cite('output-available', { ok: true, type: 'page', id: 'p2' }),
        cite('output-available', {
          ok: true,
          type: 'page',
          title: 'Bad url',
          url: 'javascript:alert(1)',
        }),
      ]),
      ctx
    );
    expect(chips.map(c => c.title)).toEqual(['A', 'Bad url']);
    expect(chips[1].url).toBeNull();
  });
});

describe('steps', () => {
  it('one line per tool call id; done replaces running', () => {
    const steps = stepsOf(
      msg([
        {
          type: 'data-step',
          id: 'call-1',
          data: { title: 'Searching course content', status: 'running' },
        },
        { type: 'data-step', id: 'call-2', data: { title: 'Reading Syllabus', status: 'running' } },
        {
          type: 'data-step',
          id: 'call-1',
          data: { title: 'Searching course content', status: 'done' },
        },
        { type: 'data-step', id: 'call-3', data: { title: 'Checking the calendar' } },
        { type: 'data-step', id: 'call-4', data: { status: 'done' } },
      ])
    );
    expect(steps).toEqual([
      { id: 'call-1', title: 'Searching course content', done: true },
      { id: 'call-2', title: 'Reading Syllabus', done: false },
      { id: 'call-3', title: 'Checking the calendar', done: true },
    ]);
  });
});
