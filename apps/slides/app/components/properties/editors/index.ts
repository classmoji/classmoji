/**
 * Element Property Editors Registry
 *
 * Maps element types to their property editor components.
 * Adding a new element type is as simple as:
 *   1. Create a new editor component (e.g., ImageProperties.jsx)
 *   2. Import and add it to this registry
 *   3. Add detection in ElementSelectionContext.detectElementType()
 */

import CodeBlockProperties from './CodeBlockProperties';
import TextProperties from './TextProperties';
import ImageProperties from './ImageProperties';
import SlideProperties from './SlideProperties';
import ColumnProperties from './ColumnProperties';
import IframeProperties from './IframeProperties';
import VideoProperties from './VideoProperties';
import BlockProperties from './BlockProperties';
import SandpackProperties from './SandpackProperties';

export const elementPropertyEditors = {
  code: CodeBlockProperties,
  text: TextProperties,
  image: ImageProperties,
  slide: SlideProperties,
  column: ColumnProperties,
  iframe: IframeProperties,
  video: VideoProperties,
  block: BlockProperties,
  sandpack: SandpackProperties,
};

export { CodeBlockProperties, TextProperties, ImageProperties, SlideProperties, ColumnProperties, IframeProperties, VideoProperties, BlockProperties, SandpackProperties };
