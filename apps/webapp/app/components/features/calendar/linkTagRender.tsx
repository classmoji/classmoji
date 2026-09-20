/**
 * The chip a linked page, deck or assignment gets inside the add/edit modals'
 * pickers — and the star on it.
 *
 * A week view lists everything an event links to; a month cell has room for one
 * line. The star is where the instructor says which link that line shows. There
 * is at most ONE per event date, across all three pickers, which is why the
 * state lives in the modal (`useFeaturedLink`) and is handed to each picker
 * rather than kept per Select.
 *
 * ── WHY THE TAG IS BUILT BY HAND ────────────────────────────────────────────
 * antd renders a tag for us, but not one with controls on it. `tagRender` hands
 * over the whole chip, which means we also owe it the close "×" — rc-select
 * only draws its own when it is drawing the whole tag.
 *
 * It also wraps whatever we return in a `<span onMouseDown>` that TOGGLES THE
 * DROPDOWN (rc-select's `customizeRenderSelector`). So every control in here
 * stops mousedown from propagating; stopping click alone would leave the
 * dropdown flapping open on every star. `preventDefault` on the same event is
 * what antd's own remove button does: it keeps focus in the search input
 * instead of dragging it onto the control that was clicked.
 *
 * The option `label` stays a plain string on purpose — search matches on it
 * (`optionFilterProp="label"`) and a React element there makes a draft page
 * unfindable by name. The draft flag is looked up by VALUE instead, through the
 * meta map below, and the dropdown row is decorated by `renderLinkOption`.
 */

import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from 'antd';
import { IconStar, IconStarFilled } from '@tabler/icons-react';
import DraftPill from './DraftPill';

/** The three things a calendar event can link, and therefore can star. */
export type FeaturedKind = 'page' | 'slide' | 'assignment';

/** Which linked resource the month view should show under this event. */
export interface FeaturedRef {
  kind: FeaturedKind;
  id: string;
}

/** What hovering the star explains. One sentence, and it names the limit. */
export const FEATURED_TOOLTIP = 'Show this one in month view — only one per date.';

/**
 * What a tag needs to know about the option behind it.
 *
 * `tagRender` is given a value and whatever `label` the option carried, so
 * anything else — is this one a draft? — has to be looked up by value.
 */
export interface LinkOptionMeta {
  title: string;
  isDraft: boolean;
}

export type LinkOptionMetaMap = Map<string, LinkOptionMeta>;

/** An option as the pickers build it: a string label plus the draft flag. */
export interface LinkOption {
  value: string;
  label: string;
  is_draft: boolean;
}

/** A resource a picker can offer. */
export interface LinkPickerItem {
  id: string;
  title: string;
  is_draft?: boolean;
}

/**
 * Turn a loader's resource list into `Select` options and the meta map the tag
 * renderer reads, so the two can never disagree about a title.
 */
export const buildLinkOptions = <T extends LinkPickerItem>(
  items: T[],
  labelOf: (item: T) => string = item => item.title
): { options: LinkOption[]; meta: LinkOptionMetaMap } => {
  const options = items.map(item => ({
    value: item.id,
    label: labelOf(item),
    is_draft: Boolean(item.is_draft),
  }));

  return {
    options,
    meta: new Map(options.map(o => [o.value, { title: o.label, isDraft: o.is_draft }])),
  };
};

/** The dropdown row: the same string the search matches, plus a Draft pill. */
export const renderLinkOption = (option: { label?: ReactNode; data?: LinkOption }): ReactNode => (
  <span className="inline-flex items-center gap-2 min-w-0">
    <span className="truncate">{option.label}</span>
    {option.data?.is_draft && <DraftPill />}
  </span>
);

/** Are these the same starred resource? Kind and id both, never id alone. */
export const isSameFeatured = (a: FeaturedRef | null, b: FeaturedRef | null): boolean =>
  Boolean(a && b && a.kind === b.kind && a.id === b.id);

/**
 * What the star becomes when this chip's star is clicked.
 *
 * Starring anything clears whatever was starred before — there is one line
 * under the event, so there is one star — and clicking the starred one again
 * clears it, which is the only way to go back to showing nothing.
 */
export const nextFeatured = (prev: FeaturedRef | null, ref: FeaturedRef): FeaturedRef | null =>
  isSameFeatured(prev, ref) ? null : ref;

/**
 * What the star becomes when a picker's selection changes.
 *
 * A star on a resource that is no longer linked would be saved as nothing and
 * shown as nothing, while the modal went on drawing it. All three ways of
 * unlinking — the chip's ×, deselecting in the dropdown, clearing the whole
 * picker — arrive here, because all three are an `onChange`.
 */
export const featuredAfterSelection = (
  prev: FeaturedRef | null,
  kind: FeaturedKind,
  ids: string[]
): FeaturedRef | null => (prev && prev.kind === kind && !ids.includes(prev.id) ? null : prev);

/**
 * The one starred link in a modal.
 *
 * Shared by both modals because both have three pickers and one star between
 * them. The two decisions it makes are the pure functions above.
 */
export const useFeaturedLink = () => {
  const [featured, setFeatured] = useState<FeaturedRef | null>(null);

  const toggleFeatured = useCallback((ref: FeaturedRef) => {
    setFeatured(prev => nextFeatured(prev, ref));
  }, []);

  /** Called with a picker's new ids; drops the star if its id is not among them. */
  const keepFeaturedWithin = useCallback((kind: FeaturedKind, ids: string[]) => {
    setFeatured(prev => featuredAfterSelection(prev, kind, ids));
  }, []);

  return { featured, setFeatured, toggleFeatured, keepFeaturedWithin };
};

/**
 * The props rc-select hands a custom tag (its `CustomTagProps`), declared here
 * rather than imported: `rc-select` is antd's dependency, not ours, and this
 * shape is structurally what antd passes.
 */
interface CustomTagProps {
  label: ReactNode;
  value: string;
  disabled?: boolean;
  closable: boolean;
  onClose: (event?: React.MouseEvent<HTMLElement>) => void;
  isMaxTag?: boolean;
}

/** mousedown on a control inside a tag: keep focus, and keep the dropdown shut. */
const swallowMouseDown = (event: React.MouseEvent<HTMLElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

interface LinkTagRenderOptions {
  /** Which picker this is — half of the star's identity. */
  kind: FeaturedKind;
  meta: LinkOptionMetaMap;
  featured: FeaturedRef | null;
  onToggleFeatured: (ref: FeaturedRef) => void;
}

export const createLinkTagRender = ({
  kind,
  meta,
  featured,
  onToggleFeatured,
}: LinkTagRenderOptions) =>
  // Named rather than anonymous: antd CALLS this to get an element, it does not
  // mount it as a component, but it returns JSX and eslint cannot tell the
  // difference without a name to go on.
  function renderLinkTag({
    label,
    value,
    disabled,
    closable,
    onClose,
    isMaxTag,
  }: CustomTagProps): ReactElement {
    // antd collapses the overflow into one "+N" pseudo-tag. It stands for
    // several links rather than naming one, so there is nothing to star or
    // unlink on it.
    if (isMaxTag) {
      return <span className="ant-select-selection-item">{label}</span>;
    }

    const info = meta.get(value);
    const title = info?.title ?? (typeof label === 'string' ? label : value);
    const isFeatured = isSameFeatured(featured, { kind, id: value });

    return (
      <span
        className={`ant-select-selection-item inline-flex items-center gap-1 ${
          isFeatured ? 'ring-1 ring-amber-400 dark:ring-amber-500' : ''
        }`}
      >
        <span className="ant-select-selection-item-content truncate">{title}</span>
        {info?.isDraft && <DraftPill />}

        <Tooltip title={FEATURED_TOOLTIP}>
          <button
            type="button"
            aria-pressed={isFeatured}
            aria-label={`Show ${title} in month view`}
            onMouseDown={swallowMouseDown}
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              onToggleFeatured({ kind, id: value });
            }}
            // Enter and Space already fire this button's click; the key events
            // then keep travelling, and the Select is listening.
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }}
            className={`shrink-0 rounded p-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
              isFeatured
                ? 'text-amber-500 dark:text-amber-400'
                : 'text-ink-4 hover:text-amber-500 dark:hover:text-amber-400'
            }`}
          >
            {isFeatured ? <IconStarFilled size={13} /> : <IconStar size={13} />}
          </button>
        </Tooltip>

        {closable && !disabled && (
          <button
            type="button"
            aria-label={`Unlink ${title}`}
            onMouseDown={swallowMouseDown}
            onClick={event => {
              event.preventDefault();
              event.stopPropagation();
              // The picker's own onChange is what clears the star, so unlinking
              // by × lands in the same place as deselecting or clearing all.
              onClose();
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            }}
            className="shrink-0 rounded px-0.5 text-ink-4 hover:text-ink-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            ×
          </button>
        )}
      </span>
    );
  };
