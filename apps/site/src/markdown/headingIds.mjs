import GithubSlugger from 'github-slugger';

/**
 * Heading ids the way Astro 5 made them: the GitHub-style slug with one
 * trailing "-" dropped. Astro 7 keeps that "-" (a heading ending in an emoji
 * or punctuation, like "Emoji?!?! 🎉", becomes `emoji-` instead of `emoji`), which
 * would break links to those headings. This runs before Astro's own heading-id
 * step, which keeps an id that is already set and lists it in the page's
 * headings, so tables of contents link to the same id. Every other heading is
 * left to Astro.
 */
export function legacyHeadingIds() {
  // A factory: Sätteri calls it once per document, so each gets its own slugger.
  return () => {
    const slugger = new GithubSlugger();
    return {
      name: 'legacy-heading-ids',
      element: {
        filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        visit(node, ctx) {
          if (typeof node.properties?.id === 'string') return;
          const slug = slugger.slug(ctx.textContent(node));
          if (slug.endsWith('-')) ctx.setProperty(node, 'id', slug.slice(0, -1));
        },
      },
    };
  };
}
