import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { useState } from 'react';
import { useClickAway } from '@uidotdev/usehooks';
import { Emoji } from '~/components';

interface EmojiPickerProps {
  setEmoji: (emojiId: string) => void;
  emoji: string | null;
}

const EmojiPicker = ({ setEmoji, emoji }: EmojiPickerProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleEmojiSelect = (emoji: { id: string }) => {
    setIsOpen(false);
    setEmoji(emoji.id);
  };

  const ref = useClickAway(() => {
    setIsOpen(false);
  });

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="h-9 min-w-[120px] px-3 border border-line rounded-lg cursor-pointer bg-panel hover:bg-panel-hover transition-colors flex items-center gap-2"
      >
        {emoji ? (
          <>
            <Emoji emoji={emoji} size="sm" />
            <span className="text-sm text-ink-1">{emoji}</span>
          </>
        ) : (
          <span className="text-sm text-ink-4">Pick emoji...</span>
        )}
      </button>

      {isOpen && (
        <div
          className="absolute top-11 z-10 shadow-lg rounded-xl overflow-hidden"
          ref={ref as React.RefObject<HTMLDivElement>}
        >
          <Picker data={data} onEmojiSelect={handleEmojiSelect} />
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;
