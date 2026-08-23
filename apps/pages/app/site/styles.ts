/**
 * Class-site stylesheet, inlined into every site document.
 *
 * ## Why this is a string and not a `.css` file
 *
 * It started as `site.css` imported from the layout route, which is the
 * idiomatic React Router way — and it silently did not ship. Route-module CSS
 * reaches the document through `<Links/>`, which in dev means React Router
 * walking the route's import graph to collect styles; on the site routes that
 * walk fails (it resolves into `@classmoji/database` → `@prisma/client`, which
 * has no browser entry point). The page still got the ~600KB of critical CSS
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
/* --- undoing editor-only layout ------------------------------------- */

/* blocknote-overrides.css gives .bn-editor a 400px min-height so the editor
   presents a comfortable click target on an empty page. On a static article
   that is dead space under every short page. Neutralized here rather than in
   the shared file: same result, no risk to the editor, and the extra classes
   win on specificity regardless of stylesheet order. */
.site-article .bn-container .bn-editor { min-height: 0; }

/* The editor reserves a gutter for drag/add-block controls. Nothing on a site
   page can be dragged, so the article owns its full width. */
.site-article .bn-editor { padding-inline: 0; }

/* --- site-only block markup ------------------------------------------ */

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

/* --- page link -------------------------------------------------------- */

/* The editor draws a pageLink as a bordered row around a SPAN, so its
   border-bottom is the only underline on screen. The site renders that same
   row around an <a>, which brings a real link underline with it, and the two
   together read as a double underline under every page link. The link's own
   underline is the one that carries meaning, so the border goes. */
.site-article .page-link-display { border-bottom: none; }

/* --- page directory (navGrid) ----------------------------------------- */

/* Restated for the site rather than inherited from the editor's stylesheet,
   for the same reason the cover band is: these tiles are a class site's
   primary navigation, and they must not degrade into flat full-width rows
   because a stylesheet that exists for the editor moved underneath them. */
.site-article .bn-nav-grid,
.site-article .nav-grid {
  gap: 10px 14px;
  /* Room between the hero above and the prose below: this block is usually
     the first thing under the page title. */
  margin: 1.25rem 0 1.5rem;
}

.site-article .bn-nav-grid .bn-nav-grid-item,
.site-article .nav-grid .bn-nav-grid-item {
  padding: 10px 13px;
  border-radius: 10px;
  border: 1px solid var(--color-border-default);
  background: var(--color-bg-subtle);
  cursor: pointer;
  /* !important because the editor's own rule sets colour that way; without it
     this rule would win every property except the one deciding legibility. */
  color: var(--color-text-default) !important;
}

.site-article .bn-nav-grid .bn-nav-grid-item:hover,
.site-article .nav-grid .bn-nav-grid-item:hover {
  background: var(--color-bg-default);
  border-color: var(--color-border-medium);
  color: var(--color-text-default) !important;
}

/* A fixed slot, always rendered (see makeStaticNavGrid): a tile with an emoji
   and one without must start their labels in the same place, or a two-column
   grid reads as misaligned. */
.site-article .bn-nav-grid-emoji {
  width: 1.25em;
  text-align: center;
}

/* Members-only entries -- shown only to the members who can already open
   them. */
.site-article .bn-nav-grid-badge {
  margin-left: auto;
  flex: none;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-subtle);
  border: 1px solid var(--color-border-medium);
  border-radius: 999px;
  padding: 1px 6px;
}

/* Two columns is unreadable on a phone. The grid template is an INLINE style
   (the block carries its author's column count), and only !important reaches
   past one. */
@media (max-width: 640px) {
  .site-article .bn-nav-grid,
  .site-article .nav-grid {
    grid-template-columns: minmax(0, 1fr) !important;
  }
}

/* --- profile cards ----------------------------------------------------- */

/* Side-by-side profiles are authored as a column list, and each card sized
   itself to its own content, so a two-line role beside a one-line role gave
   two cards of different heights. The columns already stretch; the height has
   to be carried down through BlockNote's wrapper divs to reach the card.

   Scoped with :has() to the profile block deliberately: the same chain applied
   to every block in a column would stretch callouts and terminals too, which
   is a change nobody asked for. Where :has() is unsupported this does nothing
   and the cards look exactly as they do today. */
.site-article .bn-block-column .bn-block-outer:has(> .bn-block > [data-content-type='profile']),
.site-article
  .bn-block-column
  .bn-block-outer:has(> .bn-block > [data-content-type='profile'])
  > .bn-block,
.site-article .bn-block-column .bn-block-content[data-content-type='profile'],
.site-article .bn-block-content[data-content-type='profile'] > .profile-block {
  height: 100%;
}

/* The avatar is a fixed 64px circle in the editor; a long name in a narrow
   column must not squeeze it. */
.site-article .profile-avatar-wrapper { flex: none; }

/* A genuinely long name still wraps -- it just no longer breaks mid-word when
   the column has room to spare. */
.site-article .profile-display-name,
.site-article .profile-display-title {
  overflow-wrap: break-word;
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

   2. The CONTENT surface. The article wrapper is serialized with
      data-color-scheme="light" (the scheme is a server-chosen ATTRIBUTE and the
      server can't know the visitor's preference), so BlockNote's own colour
      variables resolve to their light values.

   The dark-mode script adds .dark to <html> before first paint (no flash), so
   both fixes key off it. We (1) point the page surface + baseline text at real
   dark values -- html.dark body (0,1,2) beats Mantine's body (0,0,1) on
   specificity, and being unlayered it beats Tailwind's layered utilities too --
   and (2) re-point the WHOLE BlockNote dark palette on the wrapper, copied
   verbatim from BlockNote's own [data-color-scheme=dark] block, so every content
   surface (text, borders, tables, code, callouts, highlights) flips together and
   the site matches the app's client viewer by construction. The editor
   background is left transparent so the article flows on the dark page exactly as
   it flows on white in light mode -- no floating card, since the page title and
   site chrome sit outside the wrapper. */
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
html.dark .site-article .bn-container {
  color-scheme: dark;
  --bn-colors-editor-text: #cfcfcf;
  /* Transparent, not BlockNote's #1f1f1f: seamless on the dark page (see above). */
  --bn-colors-editor-background: transparent;
  --bn-colors-menu-text: #cfcfcf;
  --bn-colors-menu-background: #1f1f1f;
  --bn-colors-tooltip-text: #cfcfcf;
  --bn-colors-tooltip-background: #161616;
  --bn-colors-hovered-text: #cfcfcf;
  --bn-colors-hovered-background: #161616;
  --bn-colors-selected-text: #cfcfcf;
  --bn-colors-selected-background: #0f0f0f;
  --bn-colors-disabled-text: #3f3f3f;
  --bn-colors-disabled-background: #161616;
  --bn-colors-shadow: #0f0f0f;
  --bn-colors-border: #161616;
  --bn-colors-side-menu: #7f7f7f;
  --bn-colors-highlights-gray-text: #bebdb8;
  --bn-colors-highlights-gray-background: #9b9a97;
  --bn-colors-highlights-brown-text: #8e6552;
  --bn-colors-highlights-brown-background: #64473a;
  --bn-colors-highlights-red-text: #ec4040;
  --bn-colors-highlights-red-background: #be3434;
  --bn-colors-highlights-orange-text: #e3790d;
  --bn-colors-highlights-orange-background: #b7600a;
  --bn-colors-highlights-yellow-text: #dfab01;
  --bn-colors-highlights-yellow-background: #b58b00;
  --bn-colors-highlights-green-text: #6b8b87;
  --bn-colors-highlights-green-background: #4d6461;
  --bn-colors-highlights-blue-text: #0e87bc;
  --bn-colors-highlights-blue-background: #0b6e99;
  --bn-colors-highlights-purple-text: #8552d7;
  --bn-colors-highlights-purple-background: #6940a5;
  --bn-colors-highlights-pink-text: #da208f;
  --bn-colors-highlights-pink-background: #ad1a72;
}
html.dark .site-article blockquote { border-color: #3f3f3f; }
html.dark .site-article hr { border-color: #3f3f3f; }
html.dark .site-article .bn-file-name { color: #cfcfcf; }
`;
