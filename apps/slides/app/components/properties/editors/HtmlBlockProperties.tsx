import PropertySection from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';

/**
 * HtmlBlockProperties - an html block's source (its frame's srcdoc), edited
 * in the source modal. The frame's sandbox is fixed: there is nothing else
 * to set here.
 */
export default function HtmlBlockProperties({ block }: { block: HTMLElement }) {
  const { openBlockSource } = useElementSelection();
  const locked = block.closest('section')?.classList.contains('cm-locked') ?? false;

  return (
    <PropertySection title="HTML">
      <button
        type="button"
        onClick={() => openBlockSource(block)}
        disabled={locked}
        data-testid="html-block-edit-source"
        className="w-full px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Edit source
      </button>
    </PropertySection>
  );
}
