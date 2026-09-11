import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { extractText } from '../index.ts';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const page = (html: string | null | undefined, title?: string) =>
  extractText({ kind: 'page-html', html }, title ? { title } : {});

/**
 * `wrapHtmlContent` verbatim from `apps/webapp/app/utils/htmlWrapper.ts` — the
 * function that produced every legacy `pages/<slug>/index.html` in the fleet.
 * Inlined rather than imported: `packages/services` must not depend on the
 * webapp.
 */
const wrapHtmlContent = (bodyContent: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 85%;
      color: #333;
    }
    pre { background: #f5f5f5; }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;

describe('extractText — page-html', () => {
  const body = [
    '<h1>Wordle API</h1>',
    '<p class="subtitle">A short assignment</p>',
    '<p>Build an <strong>API</strong> that serves <code>/guess</code>.</p>',
    '<ul><li>ITEM ONE</li><li>ITEM TWO</li></ul>',
    '<pre><code>npm run dev</code></pre>',
  ].join('\n');

  it('yields the body text with the <style> block gone and the title prepended', () => {
    const { ok, text, notes, references } = page(wrapHtmlContent(body), 'Wordle API');

    expect(ok).toBe(true);
    expect(text.split('\n')[0]).toBe('Wordle API');
    expect(text).toContain('Build an API that serves /guess.');
    expect(text).toContain('ITEM ONE');
    expect(text).toContain('ITEM TWO');
    expect(text).toContain('npm run dev');
    // The <style> block is opaque payload, not prose.
    expect(text).not.toContain('font-family');
    expect(text).not.toContain('max-width');
    expect(text).not.toContain('#f5f5f5');
    // Head metadata never arrives — only <body> is read.
    expect(text).not.toContain('viewport');
    expect(notes).toBe('');
    expect(references).toEqual([]);
  });

  it('keeps the authored first <h1> and subtitle, which the page renderer drops', () => {
    // `extractBodyContent` (apps/pages/app/utils/content.server.ts:136-149)
    // deletes both because the renderer draws them from the DB row. An index
    // must not lose authored text that way.
    const { text } = page(wrapHtmlContent(body));
    expect(text).toContain('Wordle API');
    expect(text).toContain('A short assignment');
  });

  it('breaks blocks onto separate lines rather than running them together', () => {
    const { text } = page(wrapHtmlContent('<h2>Setup</h2><p>Clone the repo.</p>'));
    expect(text).toBe('Setup\nClone the repo.');
  });

  it('decodes entities through the parser, including ones no hand-written table has', () => {
    const { text } = page(
      wrapHtmlContent('<p>a &amp; b &lt;tag&gt; &quot;q&quot; &#39;s&#39; &mdash; &#8734;</p>')
    );
    expect(text).toBe('a & b <tag> "q" \'s\' — ∞');
  });

  it('is not fooled by a tag-shaped attribute value', () => {
    // A `>` inside an attribute ends a regex strip's "tag" early and spills the
    // rest of the markup into the text. A parser does not have that failure.
    const { text } = page(wrapHtmlContent('<p title="a > b">REAL TEXT</p>'));
    expect(text).toBe('REAL TEXT');
  });

  it('falls back to the whole document when there is no <body>', () => {
    expect(page('<p>FRAGMENT ONLY</p>').text).toBe('FRAGMENT ONLY');
  });

  it('treats an absent page as empty, and never throws', () => {
    for (const absent of ['', null, undefined]) {
      expect(() => page(absent)).not.toThrow();
      expect(page(absent)).toEqual({ ok: true, text: '', notes: '', references: [] });
    }
  });
});

/**
 * A whole `pages/<slug>/index.html` as `wrapHtmlContent` emits one: an inlined
 * stylesheet that dwarfs the body, `.heading-block` wrappers around the
 * headings, and prose carrying `<a>`, `<code>` and `<strong>` mid-sentence.
 * Invented course, real file shape.
 */
describe('extractText — page-html, a whole legacy page', () => {
  it('extracts the prose and leaves the inlined stylesheet behind', () => {
    const raw = fixture('sample-page-legacy.index.html');
    const { ok, text, notes } = page(raw, 'Widget Wiring');

    expect(ok).toBe(true);
    expect(text.split('\n')[0]).toBe('Widget Wiring');
    expect(text).toContain('Widget Wiring — Short Assignment');
    expect(text).toContain('To Turn In');
    expect(text).toContain('How comfortable do you feel you are with the widget toolchain?');
    // Inline markup rejoins into readable prose.
    expect(text).toContain('Choose WIDGETS as your team!');
    // None of the stylesheet survives, and it is the bulk of the file.
    expect(text).not.toContain('font-family');
    expect(text).not.toContain('list-style-type');
    expect(text.length).toBeLessThan(raw.length / 2);
    expect(notes).toBe('');
  });
});
