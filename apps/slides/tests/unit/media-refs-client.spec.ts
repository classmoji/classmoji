/**
 * The viewer's client-side fallback read never puts `media://` into the DOM.
 *
 * When a deck surface has no server-rendered content to hand the component, it
 * fetches the stored index.html itself (`contentUrl`). That document is
 * unresolved: its `media://` references have no URL and no browser loads the
 * scheme. The components blank them with the same pure pass the server's
 * failed reads use (`stripMediaRefs`, pinned in `deck-delivery.spec.ts`). The
 * editor keeps its references — its document goes back through a save.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const SLIDES = source('../../app/components/RevealSlides.tsx');
const PRESENTER = source('../../app/components/RevealPresenter.tsx');
const MEDIA_REFS = source('../../app/utils/mediaRefs.ts');

/** The code between the fallback fetch and the parse of what it returned. */
const fallbackOf = (text: string) =>
  text.slice(text.indexOf('await fetch(contentUrl!)'), text.indexOf('} catch (err: unknown)'));

test.describe('the client-side contentUrl fallback', () => {
  test('the deck viewer blanks media refs outside the editor', () => {
    const fallback = fallbackOf(SLIDES);
    expect(fallback).toContain('parseContent(isEditing ? html : stripMediaRefs(html))');
  });

  test('the presenter and the /follow audience view blank them', () => {
    expect(fallbackOf(PRESENTER)).toContain('parseContent(stripMediaRefs(html))');
  });

  test('the helper is browser-safe: it imports nothing', () => {
    expect(MEDIA_REFS).not.toMatch(/^import /m);
  });
});
