import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The deck engine's own fixture library, driven rather than re-invented.
import {
  CANONICAL_FIXTURE,
  CRUFT_FIXTURE,
  MULTI_ASIDE_FIXTURE,
  SANDPACK_FIXTURE,
  SANDPACK_JSON,
  STACKS_FIXTURE,
  ZERO_SECTIONS_FIXTURE,
} from '../../../slides/__tests__/fixtures.ts';
import { extractText } from '../index.ts';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const deck = (html: string | null | undefined, title?: string) =>
  extractText({ kind: 'deck-html', html }, title ? { title } : {});

describe('extractText — deck-html', () => {
  it('keeps slide bodies in text and speaker notes out of it', () => {
    const { ok, text, notes } = deck(CANONICAL_FIXTURE);

    expect(ok).toBe(true);
    expect(text).toContain('First');
    expect(text).toContain('Hello world');
    expect(text).toContain('Second');
    // Notes are instructor-facing; a student search must not be able to match
    // them through the embedded text.
    expect(text).not.toContain('Remember to pause');
    expect(notes).toBe('Remember to pause');
  });

  it('descends vertical stacks and separates stack-level notes too', () => {
    const { text, notes } = deck(STACKS_FIXTURE);

    expect(text).toContain('Flat');
    expect(text).toContain('Vertical 1');
    expect(text).toContain('Vertical 2');
    expect(notes).toContain('stack-level note');
    expect(notes).toContain('child note');
    expect(text).not.toContain('stack-level note');
    expect(text).not.toContain('child note');
  });

  it('gives a nested section its own line, without repeating it on the stack', () => {
    const { text } = deck(CRUFT_FIXTURE);
    const lines = text.split('\n');

    expect(lines).toContain('Painted');
    expect(lines).toContain('Hidden slide');
    expect(lines).toContain('child one');
    expect(lines).toContain('child two');
    // The stack container has no text of its own, so it contributes no line,
    // and its children are not counted twice.
    expect(lines.filter(line => line === 'child one')).toHaveLength(1);
  });

  it("catches an <ASIDE class='notes extra'> that a naive regex misses", () => {
    // The regex at apps/slides/app/routes/$slideId/route.tsx:385 is
    // case-sensitive on a double-quoted class and only looks at the last
    // aside — this fixture defeats all three assumptions.
    const { text, notes } = deck(MULTI_ASIDE_FIXTURE);

    expect(text).toContain('Talk');
    expect(text).toContain('Body between asides');
    expect(text).not.toContain('First note');
    expect(text).not.toContain('Second note');
    expect(notes).toContain('First note');
    expect(notes).toContain('Second note');
  });

  it('never lets a Sandpack JSON payload into the text', () => {
    const { text } = deck(SANDPACK_FIXTURE);

    expect(text).toContain('Playground');
    expect(text).not.toContain(SANDPACK_JSON);
    expect(text).not.toContain('/App.js');
    expect(text).not.toContain('export default function App');
    expect(text).not.toContain('body { margin: 0; }');
  });

  it('reports a failure — not an innocent empty result — when a deck has no sections', () => {
    expect(() => deck(ZERO_SECTIONS_FIXTURE)).not.toThrow();

    const result = deck(ZERO_SECTIONS_FIXTURE, 'Empty');
    expect(result.ok).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toMatch(/could not be parsed/);
    // Not even the title rides out of a failed extraction — `ok: false` means
    // "do not index this", and a title-only row would look like a real one.
    expect(result.text).not.toContain('Empty');
  });

  it('returns a failure, never the notes, for a malformed notes-only deck', () => {
    // The reproduction that motivated the rule: the document does not parse as
    // a deck, and everything in it is staff-only.
    const notesOnly = `<!DOCTYPE html><html><head><title>Week 9</title></head><body>
      <div class="reveal"><div class="slides">
        <ASIDE class='notes extra'>SOLUTION KEY: the answer is 42</ASIDE>
      </div></div>
    </body></html>`;

    const { ok, text, notes, error } = deck(notesOnly);

    expect(ok).toBe(false);
    expect(text).toBe('');
    expect(text).not.toContain('SOLUTION KEY');
    expect(error).toMatch(/could not be parsed/);
    // The notes were still separated out structurally, in their own field.
    expect(notes).toContain('SOLUTION KEY: the answer is 42');
  });

  it('strips notes before the fallback, so a degraded parse still cannot leak them', () => {
    // No <section>, so the deck does not parse — but the body has real text,
    // which is worth keeping. What must not come with it is the aside.
    const broken = `<!DOCTYPE html><html><head><title>T</title></head><body>
      <div class="reveal"><div class="slides">
        <div>VISIBLE BODY</div>
        <ASIDE class='notes extra'>PRIVATE NOTE</ASIDE>
      </div></div>
    </body></html>`;
    const { ok, text, notes } = deck(broken);

    expect(ok).toBe(true);
    expect(text).toContain('VISIBLE BODY');
    expect(text).not.toContain('PRIVATE NOTE');
    expect(notes).toBe('PRIVATE NOTE');
  });

  it('treats an absent deck as empty, and never throws', () => {
    for (const absent of ['', null, undefined]) {
      expect(() => deck(absent)).not.toThrow();
      expect(deck(absent)).toEqual({ ok: true, text: '', notes: '', references: [] });
    }
  });
});

describe('extractText — deck-html, a real cs52 deck', () => {
  it('separates a real instructor note from the slide bodies', () => {
    const { ok, text, notes } = deck(fixture('cs52-deck.index.html'), 'Intro to Frontend Testing');

    expect(ok).toBe(true);
    expect(text.split('\n')[0]).toBe('Intro to Frontend Testing');
    expect(text).toContain('your host for this adventure is Tim Tregubov');
    expect(text).toContain('Frontend Testing');
    expect(text).toContain('survey results');

    expect(notes).toContain('good mix of backgrounds and desires');
    expect(text).not.toContain('good mix of backgrounds and desires');

    // The head's <style> override block and the Reveal bootstrap are not prose.
    expect(text).not.toContain('pointer-events');
    expect(text).not.toContain('Reveal.initialize');
  });
});
