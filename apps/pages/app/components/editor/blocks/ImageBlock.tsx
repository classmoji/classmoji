import { createImageBlockConfig, imageParse } from '@blocknote/core';
import {
  createReactBlockSpec,
  ImageToExternalHTML,
  ResizableFileBlockWrapper,
  type ReactCustomBlockRenderProps,
} from '@blocknote/react';
import { IconPhoto } from '@tabler/icons-react';

import { useResolvedFileUrl } from './useResolvedFileUrl.ts';
import { useAssetSrcSets } from '~/hooks/useAssetSrcSets.ts';
import { imageSizesFor, responsiveImageAttrs } from '~/utils/imageSizes.ts';

/**
 * BlockNote's image block, with responsive candidates.
 *
 * ## Why this block is overridden rather than decorated
 *
 * The first attempt hung `srcset` off the rendered `<img>` with a
 * MutationObserver. It never fired usefully and could not have: BlockNote
 * paints `<img src="{stored ref}">` first and swaps the resolved URL in as an
 * ATTRIBUTE mutation, which a childList observer does not see — and even keyed
 * and timed correctly it would have cost a second network request per image,
 * because the browser starts fetching the moment `src` lands and re-runs its
 * candidate selection when `srcset` arrives afterwards. `src`, `srcset` and
 * `sizes` have to be on the element before it is inserted, which means they
 * have to come from the render.
 *
 * ## What this gives up
 *
 * Nothing that was BlockNote's to give. This is BlockNote's own composition —
 * `ResizableFileBlockWrapper` around an `<img class="bn-visual-media">` — so
 * the resize handles, the upload placeholder, the caption, the "showPreview
 * off" filename view and every formatting-toolbar file button still work,
 * because they all live in the wrapper or key off the block TYPE, which is
 * still `image`. `parse` and `toExternalHTML` are BlockNote's, untouched. The
 * one visible difference is the add-image button's icon, which is the app's
 * Tabler `IconPhoto` instead of the react-icons glyph BlockNote ships.
 */

type ImageRenderProps = Omit<
  ReactCustomBlockRenderProps<
    ReturnType<typeof createImageBlockConfig>['type'],
    ReturnType<typeof createImageBlockConfig>['propSchema'],
    ReturnType<typeof createImageBlockConfig>['content']
  >,
  'contentRef'
>;

/**
 * The `<img>` itself: BlockNote's, plus the two attributes it has no seam for.
 *
 * `resolveFileUrl` returns ONE string, so the candidate list cannot ride along
 * with it — it is looked up separately, by the stored reference, which the
 * block has synchronously on its first render. Both land in the same commit.
 */
function ResponsiveImagePreview(props: ImageRenderProps) {
  const { url, caption, name, previewWidth } = props.block.props;

  // The stored reference stays in the block; this is the URL to display it
  // with. Same call the app's other custom blocks make.
  const ref = typeof url === 'string' ? url : '';
  const src = useResolvedFileUrl(ref, props.editor.resolveFileUrl);
  // Keyed by the STORED reference, which the block has synchronously on its
  // first render — the signed URL arrives later and depends on a clock, an
  // expiry bucket and the viewer's tier.
  const responsive = responsiveImageAttrs(
    useAssetSrcSets(),
    ref,
    imageSizesFor(typeof previewWidth === 'number' ? previewWidth : null)
  );

  return (
    <img
      className="bn-visual-media"
      src={src}
      {...responsive}
      alt={(caption as string) || (name as string) || 'BlockNote image'}
      contentEditable={false}
      draggable={false}
    />
  );
}

/**
 * `ResizableFileBlockWrapper` is typed for the generic `file` block, so an
 * `image` block's props do not structurally satisfy it — its `type` is the
 * literal `"file"`. BlockNote composes its own image block out of this exact
 * wrapper, so the mismatch is in the published types, not in the behaviour;
 * the cast is at the one boundary where that is true.
 */
type FileWrapperProps = Parameters<typeof ResizableFileBlockWrapper>[0];

export const ResponsiveImage = createReactBlockSpec(createImageBlockConfig, options => ({
  parse: imageParse(options),
  render: props => (
    <ResizableFileBlockWrapper
      {...(props as unknown as FileWrapperProps)}
      buttonIcon={<IconPhoto size={24} />}
    >
      <ResponsiveImagePreview {...props} />
    </ResizableFileBlockWrapper>
  ),
  toExternalHTML: ImageToExternalHTML,
}));
