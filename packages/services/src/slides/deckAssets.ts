import * as cheerio from 'cheerio';

/**
 * Render-time asset rewriting for generated deck HTML.
 *
 * A deck stores its images the way it always has — `/content/{org}/{repo}/{path}`
 * — and the delivery layer turns those into signed URLs at READ time only. This
 * module is the pass that does it, and it is deliberately a DOM pass rather
 * than a string replace: a deck's slide bodies are author-written HTML, and
 * a regex over `src="..."` matches inside `data-*` attributes, inside `<code>`
 * samples, and inside anything else an instructor pasted. Parsing and
 * re-serializing cannot have that class of bug.
 *
 * Four places hold a URL worth rewriting:
 *   - `src`     — images, videos, iframes;
 *   - `href`    — downloadable attachments (and stylesheet links, which the
 *                 caller is expected to exclude — see below);
 *   - `srcset`  — a comma-separated candidate list, each with its own URL;
 *   - `style`   — inline `background-image: url(...)` and friends.
 *
 * Everything the resolver does not map is left byte-identical. That includes
 * theme stylesheets: a theme is signed as a FOLDER so its relative `url()`
 * references keep working, and rewriting its `<link href>` to a blob URL would
 * break exactly that. The caller's resolver is what declines those.
 */

/** Split a `srcset` into its candidates without losing the descriptors. */
function splitSrcSet(value: string): { url: string; descriptor: string }[] {
  return value
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => {
      const space = part.search(/\s/);
      return space === -1
        ? { url: part, descriptor: '' }
        : { url: part.slice(0, space), descriptor: part.slice(space) };
    });
}

/** Every `url(...)` in a CSS declaration list, with its quoting preserved. */
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

function cssUrls(style: string): string[] {
  const found: string[] = [];
  for (const match of style.matchAll(CSS_URL)) found.push(match[2].trim());
  return found;
}

function rewriteCssUrls(style: string, map: (ref: string) => string | undefined): string {
  return style.replace(CSS_URL, (whole, quote: string, ref: string) => {
    const next = map(ref.trim());
    return next === undefined ? whole : `url(${quote}${next}${quote})`;
  });
}

/**
 * Rewrite every asset URL in a deck document that `resolve` has a mapping for.
 *
 * `resolve` is handed every candidate reference at once so the caller can do a
 * single batched lookup, and returns only the ones it wants changed — a
 * reference absent from the returned map is left exactly as it was.
 *
 * Returns the input string untouched when there is nothing to change, so a
 * caller can use it unconditionally without paying a re-serialization.
 */
export async function rewriteDeckAssetUrls(
  html: string,
  resolve: (refs: string[]) => Promise<Map<string, string>>
): Promise<string> {
  if (!html) return html;

  const $ = cheerio.load(html);
  const candidates = new Set<string>();

  const elements = $('[src], [srcset], [href], [style]').toArray();

  for (const el of elements) {
    const { src, srcset, href, style } = el.attribs;
    if (src) candidates.add(src);
    if (href) candidates.add(href);
    if (srcset) for (const part of splitSrcSet(srcset)) candidates.add(part.url);
    if (style) for (const url of cssUrls(style)) candidates.add(url);
  }

  if (candidates.size === 0) return html;

  const resolved = await resolve([...candidates]);
  if (resolved.size === 0) return html;

  const map = (ref: string): string | undefined => {
    const next = resolved.get(ref);
    return next === undefined || next === ref ? undefined : next;
  };

  let changed = false;

  for (const el of elements) {
    const { src, srcset, href, style } = el.attribs;

    const nextSrc = src ? map(src) : undefined;
    if (nextSrc !== undefined) {
      el.attribs['src'] = nextSrc;
      changed = true;
    }

    const nextHref = href ? map(href) : undefined;
    if (nextHref !== undefined) {
      el.attribs['href'] = nextHref;
      changed = true;
    }

    if (srcset) {
      const parts = splitSrcSet(srcset);
      if (parts.some(part => map(part.url) !== undefined)) {
        el.attribs['srcset'] = parts
          .map(part => `${map(part.url) ?? part.url}${part.descriptor}`)
          .join(', ');
        changed = true;
      }
    }

    if (style) {
      const nextStyle = rewriteCssUrls(style, map);
      if (nextStyle !== style) {
        el.attribs['style'] = nextStyle;
        changed = true;
      }
    }
  }

  if (!changed) return html;

  // A full document keeps its doctype/head; a fragment round-trips as a
  // fragment. cheerio's `html()` on the root does the right thing for both.
  return $.root().html() ?? html;
}
