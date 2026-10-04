import { useCallback, useRef, useState } from 'react';
import { ColorPicker, Segmented } from 'antd';

import { useToast } from '~/hooks';
import PropertySection, { PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import {
  SVG_FIT_VALUES,
  svgFitOf,
  svgFromSource,
  svgOfBlock,
  type SvgFit,
} from '../../blocks/slideBlocks';

/** Largest svg file read in (a slide's html is capped at 200 KB). */
const MAX_SVG_BYTES = 150_000;

const FIT_OPTIONS: Array<{ value: SvgFit; label: string }> = [
  { value: 'meet', label: 'Contain' },
  { value: 'slice', label: 'Cover' },
  { value: 'none', label: 'Stretch' },
];

/**
 * SvgProperties - an svg block: its source (modal, or a .svg file), how the
 * drawing fits the block, and its colour (`color` on the block content, which
 * `currentColor` in the drawing follows).
 */
export default function SvgProperties({ block }: { block: HTMLElement }) {
  const { openBlockSource, onContentChange } = useElementSelection();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  // DOM-backed values: re-read on every render, bumped after each write.
  const [, setVersion] = useState(0);
  const bump = () => setVersion(v => v + 1);

  const locked = block.closest('section')?.classList.contains('cm-locked') ?? false;
  const content = block.querySelector(':scope > .sl-block-content') as HTMLElement | null;
  const svg = svgOfBlock(block);
  const fit = svgFitOf(svg);
  const color = content?.style.color ?? '';

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !content) return;
      if (file.size > MAX_SVG_BYTES) {
        toast.error(`${file.name} is over ${Math.round(MAX_SVG_BYTES / 1000)} KB`);
        return;
      }
      const result = svgFromSource(await file.text(), document);
      if (!result.ok) {
        toast.error(`${file.name}: ${result.error}`);
        return;
      }
      const current = svgOfBlock(block);
      if (current) current.replaceWith(result.svg);
      else content.append(result.svg);
      bump();
      onContentChange?.();
    },
    [block, content, onContentChange, toast]
  );

  const setFit = useCallback(
    (value: SvgFit) => {
      const target = svgOfBlock(block);
      if (!target) return;
      target.setAttribute('preserveAspectRatio', SVG_FIT_VALUES[value]);
      bump();
      onContentChange?.();
    },
    [block, onContentChange]
  );

  const setColor = useCallback(
    (value: string | null) => {
      if (!content) return;
      if (value) content.style.color = value;
      else content.style.removeProperty('color');
      if (content.getAttribute('style') === '') content.removeAttribute('style');
      bump();
      onContentChange?.();
    },
    [content, onContentChange]
  );

  return (
    <PropertySection title="SVG">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => openBlockSource(block)}
          disabled={locked}
          data-testid="svg-block-edit-source"
          className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Edit source
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={locked}
          className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Replace…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".svg,image/svg+xml"
          className="hidden"
          data-testid="svg-block-file"
          onChange={e => {
            void handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <div>
        <PropertyLabel>Fit</PropertyLabel>
        <Segmented
          size="small"
          block
          value={fit}
          disabled={locked || !svg}
          options={FIT_OPTIONS}
          onChange={value => setFit(value as SvgFit)}
        />
      </div>

      <div>
        <PropertyLabel>Colour</PropertyLabel>
        <ColorPicker
          size="small"
          allowClear
          showText
          disabled={locked}
          value={color || undefined}
          onChangeComplete={c => setColor(c.cleared ? null : c.toHexString())}
          onClear={() => setColor(null)}
        />
      </div>
    </PropertySection>
  );
}
