/**
 * Save-time cleanup for Sandpack sl-blocks, shared by the editor's
 * getCurrentContent (RevealSlides) and the diff-at-save snapshot
 * (deckOpsDiff cleanupContainer) so the two sides stay byte-comparable.
 *
 * Rule: strip only what the live editor ADDED to a block — the React mount
 * SandpackRenderer appends inside the embed, and stray text typed into the
 * block through contenteditable. Everything else is carried through as-is:
 * the existing embed and files-script elements are kept, so every attribute
 * (data-visible-files, data-show-line-numbers, ones this editor has never
 * heard of) survives in its original order. Rebuilding the embed from a
 * fixed attribute list is what dropped data-visible-files in prod.
 *
 * Pure DOM, no React — deckOpsDiff runs it in Node-side unit tests too.
 * Idempotent: running it on already-clean HTML changes nothing.
 */

const FILES_SCRIPT = 'script[data-sandpack-files]';

/** Remove every child of `parent` except `keep` and whitespace-only text. */
function keepOnly(parent: Element, keep: Element): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child === keep) continue;
    if (child.nodeType === 3 /* TEXT_NODE */ && (child.textContent ?? '').trim() === '') continue;
    child.remove();
  }
}

export function cleanSandpackBlocks(container: ParentNode): void {
  container.querySelectorAll('.sl-block[data-block-type="sandpack"]').forEach(block => {
    const embed = block.querySelector('.sandpack-embed');
    const script = embed?.querySelector(FILES_SCRIPT);

    // Blocks with no embed or no files payload are leftovers of corrupted
    // save/load cycles — nothing to render, so they are dropped.
    if (!embed || !script) {
      block.remove();
      return;
    }

    // Embed children: only the files script survives (the React mount and
    // anything typed into the block go).
    keepOnly(embed, script);

    // The block content holds the embed and nothing else. An embed that ended
    // up nested deeper is lifted back to its place.
    const content = block.querySelector('.sl-block-content');
    if (content) {
      if (embed.parentElement === content) keepOnly(content, embed);
      else content.replaceChildren(embed);
    }

    // The payload is serialized as raw script text: a literal `</script>` in
    // a file (written back by the live editor's JSON.stringify) would close
    // the tag early on the next parse. Stored payloads are already escaped,
    // so this is a no-op for them.
    const text = script.textContent ?? '';
    const safe = text.replace(/<\/script>/gi, '<\\/script>');
    if (safe !== text) script.textContent = safe;
  });
}
