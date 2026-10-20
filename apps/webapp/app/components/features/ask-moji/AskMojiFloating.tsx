import { AskMojiProvider } from './AskMojiProvider';
import AskMojiPanel, { type AskMojiPanelProps } from './AskMojiPanel';

/**
 * The webapp's floating panel and its controller: the chunk `AskMojiRoot`
 * loads the first time the panel opens (the AI SDK and the Trigger transport
 * come with it, never before).
 */
export default function AskMojiFloating({
  classroomSlug,
  viewAs,
  ...panel
}: Omit<AskMojiPanelProps, 'mode'> & { viewAs: string | null }) {
  return (
    <AskMojiProvider classroomSlug={classroomSlug} viewAs={viewAs}>
      <AskMojiPanel mode="floating" classroomSlug={classroomSlug} {...panel} />
    </AskMojiProvider>
  );
}
