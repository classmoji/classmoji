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
 * Everything here is scoped under `.site-article` or a site-only class, so it
 * is unreachable from the editor host. That scoping is the point: the editor
 * is a release-blocking surface, and a stylesheet is exactly the kind of
 * change that regresses one silently.
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
   does not depend on a stylesheet that exists for the editor's benefit. */
.page-header-image {
  height: 20vh;
  min-height: 140px;
  max-height: 280px;
  background-size: cover;
  background-repeat: no-repeat;
}

/* --- dark mode -------------------------------------------------------- */

/* The article wrapper is serialized with data-color-scheme="light", because
   the scheme is an ATTRIBUTE chosen on the server and the server does not know
   the visitor's preference — the document's dark-mode script only adds .dark
   to <html> once the page reaches the browser. Rather than guess (or add a
   theme cookie, a bigger decision than a stylesheet), the dark variant re-points
   the BlockNote colour variables the serialized markup already consumes. No
   flash: the class is set before first paint. */
html.dark .site-article .bn-container {
  color-scheme: dark;
  --bn-colors-editor-text: #dcddde;
  --bn-colors-editor-background: transparent;
  --bn-colors-hovered-background: #2f2f2f;
  --bn-colors-side-menu: #7d7d7d;
}
html.dark .site-article .bn-editor { color: #dcddde; }
html.dark .site-article blockquote { border-color: #3f3f3f; }
html.dark .site-article hr { border-color: #3f3f3f; }
html.dark .site-article .bn-file-name { color: #dcddde; }
`;
