import { useState } from 'react';
import { Popover } from 'antd';

import EmojiGradeOptions, { type GraderRepositoryAssignment } from './EmojiGradeOptions';

interface EmojiGraderProps {
  repositoryAssignment: GraderRepositoryAssignment;
  emojiMappings: Record<string, unknown>;
}

/** "Grade": the grade options in a hover popover. */
const EmojiGrader = ({ repositoryAssignment, emojiMappings }: EmojiGraderProps) => {
  const [show, setShow] = useState(false);

  return (
    <Popover
      // Hover opens it; a click must keep it open, not toggle it shut (a click
      // trigger on top of hover closes what the hover just opened).
      trigger="hover"
      mouseEnterDelay={0.15}
      open={show}
      onOpenChange={setShow}
      placement="top"
      overlayInnerStyle={{ padding: '10px 12px' }}
      content={
        <EmojiGradeOptions
          repositoryAssignment={repositoryAssignment}
          emojiMappings={emojiMappings}
          testId="emoji-grade-popover"
          className="flex flex-wrap gap-2 max-w-[23rem]"
        />
      }
    >
      <button
        type="button"
        onClick={() => setShow(true)}
        data-testid="emoji-grade-trigger"
        className="text-sm font-medium text-ink-2 hover:text-ink-1 hover:underline underline-offset-2 cursor-pointer"
      >
        Grade
      </button>
    </Popover>
  );
};

export default EmojiGrader;
