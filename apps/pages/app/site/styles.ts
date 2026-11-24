/**
 * Class-site stylesheet, inlined into every site document.
 *
 * ## Why this is a string and not a `.css` file
 *
 * It started as `site.css` imported from the layout route, which is the
 * idiomatic React Router way — and it silently did not ship. Route-module CSS
 * reaches the document through `<Links/>`, which in dev means React Router
 * walking the route's import graph to collect styles; on the site routes that
 * walk failed (it resolved into `@classmoji/database` → `@prisma/client`, which
 * had no browser entry point then). The page still got the ~600KB of critical CSS
 * that `root.tsx` imports, so nothing looked broken — the only symptom was
 * that these particular rules were absent, which is exactly the kind of
 * failure that survives review.
 *
 * Since these rules are load-bearing (without the first one, every short page
 * carries 400px of dead space), correctness beats idiom: an inline `<style>`
 * ships in dev and prod alike, with no bundler participation. It costs ~2KB
 * per response, uncompressed, and the CSP already allows inline styles because
 * BlockNote's serializer emits inline `style` attributes.
 *
 * Almost everything here is scoped under `.site-article` or a site-only class,
 * so it cannot reach into editor content. The one deliberate exception is the
 * dark-mode page surface (`html.dark`, `html.dark body`), which has to own the
 * whole document. Even that is safe, because this stylesheet is loaded in
 * exactly ONE place — `SiteDocument` via `app/site/layout.tsx` — and never
 * ships to the editor host at all. The editor is a release-blocking surface a
 * stylesheet can regress silently; nothing here can touch it.
 */
export const SITE_STYLES = `
/* --- the reader island in site chrome ------------------------------- */

/* The reader's fixed-position pieces and its heading anchors, placed for the
   site's top bar rather than the app's header (components/comments,
   styles/page-reader.css). The identity bar scrolls away with the page, so a
   #heading lands a little below the viewport's top, and the floating comments
   button and panel sit just under the bar's height. */
:root {
  --reader-anchor-offset: 1rem;
  --reader-comments-button-top: 4rem;
  --reader-comments-panel-top: 4rem;
}

/* The mount element holds room for the document while the island loads, so
   the footer does not jump when it arrives; once the reader is on screen the
   page is as tall as its content. */
.site-reader-root { min-height: 60vh; }
.site-reader-root:has(.page-reader[data-reader-ready]) { min-height: 0; }

/* A page whose island never mounts (the entry blocked, failed, or gone after
   a deploy while this HTML sat in a cache) must not show "Loading content..."
   forever. Pure CSS, in this inline sheet because no other file may load: the
   loading line gives way to the failure line after 10 seconds. React replaces
   these elements when the reader mounts, so a working page never shows it.
   Not disabled under prefers-reduced-motion (it is a change of words, not
   motion); only the fade is. With scripting off, the noscript line says why
   and the loading line is not shown. */
.reader-island-wait {
  display: grid;
  justify-items: center;
  padding: 3rem 1rem;
  color: #6b7280;
  text-align: center;
}
html.dark .reader-island-wait { color: #9ca3af; }
.reader-island-wait > span { grid-area: 1 / 1; }
.reader-island-wait-loading {
  animation: reader-island-stalled-out 0s linear 10s forwards;
}
.reader-island-wait-failed {
  visibility: hidden;
  animation: reader-island-stalled-in 0s linear 10s forwards;
}
@media (prefers-reduced-motion: no-preference) {
  .reader-island-wait-failed { animation-duration: 0.3s; }
}
@keyframes reader-island-stalled-out { to { visibility: hidden; } }
@keyframes reader-island-stalled-in {
  from { visibility: visible; opacity: 0; }
  to { visibility: visible; opacity: 1; }
}
.reader-island-noscript {
  padding: 1rem;
  color: #374151;
  text-align: center;
}
html.dark .reader-island-noscript { color: #d1d5db; }
@media (scripting: none) {
  .reader-island-wait { display: none; }
}

/* --- the cover ------------------------------------------------------ */

/* Cover images: the same fixed band the editor uses, restated so a site page
   does not depend on a stylesheet that exists for the editor's benefit.

   The numbers are page-viewer.css's, to the pixel, and that is the point. A
   viewport-relative band here meant the same cover was cropped differently in
   the two surfaces, so an author who positioned an image against the editor's
   192/256/288px band published a different slice of it. If page-viewer.css
   ever changes these, this block changes with it -- site-render.spec.ts fails
   until it does. */
.page-header-image {
  height: 12rem;
  background-size: cover;
  background-repeat: no-repeat;
}
@media (min-width: 768px) {
  .page-header-image { height: 16rem; }
}
@media (min-width: 1024px) {
  .page-header-image { height: 18rem; }
}

/* --- Tiptap's editor rules ------------------------------------------- */

/* Two of the rules Tiptap injects wherever an editor runs (@tiptap/core's
   style.ts, on .ProseMirror), which the static render, having no editor,
   never got (the reader island runs one, so Tiptap injects them itself). The
   static article wrapper carries .ProseMirror too (siteArticleWrapper).

   Ligatures off: JetBrains Mono turned != into one glyph in code that reads
   != in the app.

   A terminal's long lines wrap, as in the app, instead of running out of the
   block. :where() keeps Tiptap's specificity, so BlockNote's own rule that a
   code block does not wrap still wins here as it does there. */
.site-article .ProseMirror {
  -webkit-font-variant-ligatures: none;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0;
}
:where(.site-article) .ProseMirror pre {
  white-space: pre-wrap;
}

/* --- the static render's markup -------------------------------------- */

/* Everything from here to the dark-mode section styles markup only the OLD
   static render (site/render.server.ts) produces. Class sites no longer serve
   it (the reader island draws every page); these go with that render in the
   follow-up that deletes it. */

/* A block this viewer may not see renders as an empty placeholder; hiding it
   keeps it from contributing vertical rhythm where content used to be. */
.bn-site-empty { display: none; }

/* A URL that could not be safely embedded degrades to a plain link. */
.bn-site-fallback-link { word-break: break-all; }

/* Toggles render expanded on a static page; the marker says "this was
   authored as a toggle", it is not a control. */
.bn-site-toggle { display: flex; align-items: baseline; gap: 0.4rem; }
.bn-site-toggle-marker { opacity: 0.45; font-size: 0.8em; line-height: 1.6; }

/* Embedded frames keep their 16:9 box. */
.bn-site-frame { border-radius: 0.5rem; }

/* A locked section is always closed on a class site: a card with a padlock,
   the section's title and a link to the page in Classmoji, where a student
   unlocks it. Its body never reaches this HTML (redacted before rendering),
   so there is nothing under the card to hide. */
.site-article .bn-site-locked {
  width: 100%;
  margin: 0.25rem 0;
  padding: 0.75rem 0.875rem 0.625rem;
  border: 1px solid rgba(55, 53, 47, 0.16);
  border-radius: 10px;
  background: rgba(55, 53, 47, 0.035);
}
.site-article .bn-site-locked-row { display: flex; align-items: center; gap: 0.5rem; }
.site-article .bn-site-locked-icon { flex: none; width: 16px; height: 16px; opacity: 0.6; }
.site-article .bn-site-locked-title { flex: 1; min-width: 0; margin: 0; font-weight: 600; }
.site-article .bn-site-locked-link {
  display: inline-block;
  margin: 0.375rem 0 0 1.5rem;
  font-size: 0.875em;
  color: inherit;
  opacity: 0.75;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.site-article .bn-site-locked-link:hover { opacity: 1; }
/* Signed-out visitor: no card, one row (padlock + title) linking to sign in,
   with a "Sign in to unlock" label on hover and keyboard focus. The colour and
   underline rules outrank blocknote-overrides.css's \`.bn-editor a\`. */
.site-article .bn-site-locked-gate {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: calc(100% + 1rem);
  margin: 0.125rem -0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.site-article .bn-editor a.bn-site-locked-gate,
.site-article .bn-editor a.bn-site-locked-gate:hover {
  color: inherit !important;
  text-decoration: none !important;
}
.site-article .bn-site-locked-gate .bn-site-locked-title { flex: 0 1 auto; }
.site-article .bn-site-locked-gate:hover,
.site-article .bn-site-locked-gate:focus-visible { background: rgba(55, 53, 47, 0.06); }
.site-article .bn-site-locked-gate:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
.site-article .bn-site-locked-tip {
  flex: none;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.125rem;
  white-space: nowrap;
  color: #fff;
  background: #37352f;
  opacity: 0;
  transition: opacity 120ms ease;
  pointer-events: none;
}
.site-article .bn-site-locked-gate:hover .bn-site-locked-tip,
.site-article .bn-site-locked-gate:focus-visible .bn-site-locked-tip { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .site-article .bn-site-locked-gate,
  .site-article .bn-site-locked-tip { transition: none; }
}

/* --- headings: deliberately absent ------------------------------------ */

/* Headings are NOT restated here, and adding them would be a regression.

   They used to be the same bug the cover band above fixes: sizes scoped to
   .page-editor, which a site page does not have, so the site published a 48px
   H1 against the editor's 30px (#288). The fix went the other way -- the scale
   now lives UNSCOPED in app/styles/blocknote-overrides.css as BlockNote's own
   --level custom property, which ships to every surface via root.tsx, so the
   editor, the in-app viewer and this page read one definition.

   If a heading looks wrong on a site page, fix it there, not here. A rule in
   this file would fork the scale again and only the site would move.
   site-render.spec.ts asserts this section stays empty of heading sizes. */

/* --- collapsible code blocks ------------------------------------------ */

/* A long collapsible block is served clipped, and only the copy script opens
   it. With scripting off nothing could, so the whole block shows and the bar
   and fade, which would do nothing, are not drawn. */
@media (scripting: none) {
  .site-article .bn-block-content[data-content-type="codeBlock"] > pre[data-collapse] {
    max-height: none !important;
    margin-bottom: 0 !important;
  }
  .site-article .bn-code-expand,
  .site-article .bn-code-fade { display: none !important; }
}

/* --- dark mode -------------------------------------------------------- */

/* NOTE: this block lives inside a JS template literal, so it must contain no
   backtick characters.

   Two things conspired to render a class site washed-out in an OS-dark browser
   -- light-gray text on a white page -- and both are fixed here.

   1. The PAGE surface. SiteDocument ships no MantineProvider and puts no
      data-mantine-color-scheme on <html>/<body>, yet Mantine's reset carries an
      UNLAYERED rule: body { background: var(--mantine-color-body); color:
      var(--mantine-color-text) }. With no scheme attribute those vars are
      undefined, the declaration is invalid-at-computed-value, and the body
      paints the browser's white canvas. Because that rule is unlayered it also
      beats the document's dark:bg-[#191919] utility, which Tailwind emits inside
      @layer utilities (unlayered always wins over any cascade layer). So the
      page stayed white in dark mode no matter what the wrapper did.

   2. The CONTENT surface. That one is now the reader's: the island's
      BlockNote view follows html.dark and sets its own data-color-scheme, so
      BlockNote's dark palette applies as in the app, with the app's transparent
      editor background (blocknote-overrides.css). The copy of that palette that
      lived here for the static render is gone.

   The dark-mode script adds .dark to <html> before first paint (no flash), and
   the page surface keys off it: html.dark body (0,1,2) beats Mantine's body
   (0,0,1) on specificity, and being unlayered it beats Tailwind's layered
   utilities too. The rules after it are the static render's (see above). */
html.dark {
  color-scheme: dark;
}
html.dark body {
  background-color: #191919;
  color: var(--mantine-color-dark-0);
  /* Repoint the Mantine aliases the unlayered reset consumes, so any surface
     driven by them (e.g. BlockNote's sticky table header, which uses
     var(--mantine-color-body)) is dark too. The base palette
     (--mantine-color-dark-*) is defined under a bare :root, so these resolve
     despite the missing scheme attribute. */
  --mantine-color-body: var(--mantine-color-dark-7);
  --mantine-color-text: var(--mantine-color-dark-0);
}
html.dark .site-article .bn-site-locked {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.03);
}
html.dark .site-article .bn-site-locked-gate:hover,
html.dark .site-article .bn-site-locked-gate:focus-visible { background: rgba(255, 255, 255, 0.06); }
html.dark .site-article .bn-site-locked-gate:focus-visible { outline-color: #60a5fa; }
html.dark .site-article .bn-site-locked-tip { color: #191919; background: #e5e5e5; }
`;
