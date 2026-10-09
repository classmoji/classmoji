import {
  BlockNoteSchema,
  createBlockSpec,
  createCodeBlock,
  createCodeBlockSpec,
  createImageBlockSpec,
  createPreCode,
  defaultBlockSpecs,
} from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { multiColumnSchema } from '@blocknote/xl-multi-column';

import { customBlockConfigs, type CustomBlockType } from './configs.ts';

/**
 * Default BlockNote blocks the pages app REPLACES with its own spec of the
 * same type: `video` (custom block), `codeBlock` (syntax highlighting),
 * `image` (same config, responsive render).
 */
export const REPLACED_DEFAULT_BLOCKS = ['video', 'codeBlock', 'image'] as const;

/** BlockNote's default block specs minus the ones the app replaces. */
export function pageDefaultBlockSpecs() {
  const { video: _video, codeBlock: _codeBlock, image: _image, ...rest } = defaultBlockSpecs;
  return rest;
}

/** The languages the code block's select offers, keyed by canonical id. */
const CODE_LANGUAGES: Record<string, { name: string; aliases?: readonly string[] }> =
  codeBlockOptions.supportedLanguages;

/**
 * The language select's entry for a stored `language`: the id itself when it
 * is one, the id an alias belongs to (`bash` -> `shellscript`, `js` ->
 * `javascript`, case-insensitive, like BlockNote's own alias lookup), and
 * `text` for anything else (unknown names, empty, non-strings).
 *
 * Display only. The stored value is never rewritten from this; the block
 * keeps whatever language it was saved with until a user picks another.
 */
export function codeBlockDisplayLanguage(language: unknown): string {
  if (typeof language !== 'string') return 'text';
  if (Object.hasOwn(CODE_LANGUAGES, language)) return language;
  const wanted = language.trim().toLowerCase();
  if (!wanted) return 'text';
  for (const [id, { aliases }] of Object.entries(CODE_LANGUAGES)) {
    if (id.toLowerCase() === wanted || aliases?.some(a => a.toLowerCase() === wanted)) {
      return id;
    }
  }
  return 'text';
}

/**
 * The name the language select shows for a stored `language` (`js` ->
 * `JavaScript`, anything unknown -> `Plain Text`). The class site prints it
 * as plain text where the editor has the select.
 */
export function codeBlockLanguageName(language: unknown): string {
  return CODE_LANGUAGES[codeBlockDisplayLanguage(language)].name;
}

/**
 * The code block every page schema uses: BlockNote's, with the language
 * select tolerant of any stored language.
 *
 * BlockNote 0.55's render throws `Language <x> is not supported.` when a
 * block's language is not a KEY of `supportedLanguages` — and saved pages hold
 * aliases (`bash`, `js`, `py`, `yml`), names BlockNote never knew, and `''`.
 * 0.46 just left the select blank. This is BlockNote's spec with one change:
 * the select is told `codeBlockDisplayLanguage(language)` instead of the raw
 * value. Config, parse, input rule, keyboard shortcuts, highlight language,
 * the block's `data-language` and `toExternalHTML` are BlockNote's, unchanged,
 * so documents read and write exactly as before; picking a language in the
 * select writes its canonical id.
 */
export function createPageCodeBlockSpec() {
  const base = createCodeBlockSpec(codeBlockOptions);
  // `render`/`toExternalHTML` on a built spec are already wrapped in the
  // block structure; the rebuilt spec wraps its own, so take only the rest.
  const {
    render: _render,
    toExternalHTML: _toExternalHTML,
    ...implementation
  } = base.implementation;
  return createBlockSpec(
    base.config,
    {
      ...implementation,
      render: (block, editor) =>
        createCodeBlock(block, editor, {
          selectedLanguage: codeBlockDisplayLanguage(block.props.language),
          supportedLanguages: CODE_LANGUAGES,
        }),
      toExternalHTML: block => createPreCode(block),
    },
    base.extensions
  )();
}

/**
 * A block spec with the shared config and a render that draws nothing.
 *
 * The ProseMirror node (name, content, group, attrs) comes from the config
 * alone, which is all Yjs <-> blocks conversion needs. The render exists
 * only because BlockNote requires one; nothing on the server mounts it.
 */
function serverSpec<T extends CustomBlockType>(type: T) {
  const config = customBlockConfigs[type];
  const inline = config.content === 'inline';
  return createBlockSpec(config, {
    render: () => {
      const dom = globalThis.document?.createElement('div') as HTMLElement;
      return inline ? { dom, contentDOM: dom } : { dom };
    },
  })();
}

/**
 * The page block schema with no React, no DOM and no app aliases: BlockNote's
 * defaults (minus the replaced ones), the code block, the image block,
 * multi-column, and the app's custom blocks built from the shared configs.
 *
 * Block for block, the ProseMirror schema it produces is the pages editor's
 * (pinned by apps/pages/tests/unit/page-schema-parity.spec.ts).
 */
export function createPageSchema() {
  return BlockNoteSchema.create({
    blockSpecs: {
      ...pageDefaultBlockSpecs(),
      codeBlock: createPageCodeBlockSpec(),
      image: createImageBlockSpec(),
      ...multiColumnSchema.blockSpecs,
      callout: serverSpec('callout'),
      terminal: serverSpec('terminal'),
      profile: serverSpec('profile'),
      divider: serverSpec('divider'),
      embed: serverSpec('embed'),
      video: serverSpec('video'),
      pageLink: serverSpec('pageLink'),
      navGrid: serverSpec('navGrid'),
    },
  });
}

export type PageSchema = ReturnType<typeof createPageSchema>;
