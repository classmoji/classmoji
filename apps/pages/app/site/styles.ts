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
 * BlockNote and Mantine set inline styles.
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
   ever changes these, this block changes with it -- block-styles.spec.ts fails
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
   block-styles.spec.ts asserts this section stays empty of heading sizes. */

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
   utilities too. */
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
`;
