/**
 * Save-time cleanup for Sandpack embeds, run by the shared editor cleanup
 * (editorCleanup.ts) that both the editor's getCurrentContent and the
 * diff-at-save snapshot use.
 *
 * Rule: strip only what the live editor ADDED — the React mount
 * SandpackRenderer appends inside each embed, and stray text typed into a
 * block through contenteditable. Everything else is carried through as-is:
 * the existing embed and files-script elements are kept, so every attribute
 * (data-visible-files, data-show-line-numbers, ones this editor has never
 * heard of) survives in its original order. Rebuilding the embed from a
 * fixed attribute list is what dropped data-visible-files in prod.
 *
 * Pure DOM, no React — runs in Node-side unit tests too.
 * Idempotent: running it on already-clean HTML changes nothing.
 */

const FILES_SCRIPT = 'script[data-sandpack-files]';

/**
 * HTML inter-element whitespace (ASCII only — a no-break space is content,
 * not formatting, so it does not count).
 */
const INTER_ELEMENT_WHITESPACE = /^[ \t\n\r\f]*$/;

/**
 * Remove every child node of `parent` except `keep` and text nodes made only
 * of inter-element whitespace (the stored formatting around `keep`).
 * `keep` must be a direct child of `parent`.
 */
function keepOnly(parent: Element, keep: Element): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child === keep) continue;
    if (
      child.nodeType === 3 /* TEXT_NODE */ &&
      INTER_ELEMENT_WHITESPACE.test(child.textContent ?? '')
    ) {
      continue;
    }
    child.remove();
  }
}

/**
 * The payload is serialized as raw script text, and HTML ends a script at
 * `</script` followed by whitespace, `/` or `>` — so a file holding one
 * (written back by the live editor's JSON.stringify) would close the tag
 * early on the next parse. `<\/` is the same string in JSON. Stored payloads
 * are already escaped, so this changes no bytes for them.
 */
export function escapeScriptPayload(text: string): string {
  return text.replace(/<\/(script)(?=[\s/>])/gi, '<\\/$1');
}

/**
 * One embed: only its files script survives among its children (the React
 * mount and anything typed into it go); a script that ended up nested deeper
 * is lifted back to a direct child. An embed with no files script keeps its
 * children except the live mount.
 */
function cleanEmbed(embed: Element): void {
  const script = embed.querySelector(FILES_SCRIPT);
  if (!script) {
    embed.querySelectorAll('.sandpack-mount').forEach(mount => mount.remove());
    return;
  }
  if (script.parentElement === embed) keepOnly(embed, script);
  else embed.replaceChildren(script);

  const text = script.textContent ?? '';
  const safe = escapeScriptPayload(text);
  if (safe !== text) script.textContent = safe;
}

export function cleanSandpackBlocks(container: ParentNode): void {
  container.querySelectorAll('.sl-block[data-block-type="sandpack"]').forEach(block => {
    const embed = block.querySelector('.sandpack-embed');

    // Blocks with no embed or no files payload are leftovers of corrupted
    // save/load cycles — nothing to render, so they are dropped.
    if (!embed || !embed.querySelector(FILES_SCRIPT)) {
      block.remove();
      return;
    }

    // The block content holds the embed and nothing else. An embed that ended
    // up nested deeper is lifted back to its place.
    const content = block.querySelector('.sl-block-content');
    if (content) {
      if (embed.parentElement === content) keepOnly(content, embed);
      else content.replaceChildren(embed);
    }
  });

  // Every embed, in an sl-block or bare (as hand-authored decks write them).
  container.querySelectorAll('.sandpack-embed').forEach(cleanEmbed);
}
