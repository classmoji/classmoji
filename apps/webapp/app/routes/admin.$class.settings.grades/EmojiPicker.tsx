import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { useState } from 'react';
import { useClickAway } from '@uidotdev/usehooks';
import { SCORE_EMOJI_VALUES, scoreEmojiId, scoreEmojiDataUri } from '@classmoji/utils';
import { Emoji } from '~/components';

interface EmojiPickerProps {
  setEmoji: (emojiId: string) => void;
  emoji: string | null;
}

// The built-in 0–100 grade badges as an emoji-mart custom category. emoji-mart
// keys the selection by `id`, which is the `score-N` shortcode the mapping stores.
const SCORE_CATEGORY = [
  {
    id: 'scores',
    name: 'Grade scores',
    emojis: SCORE_EMOJI_VALUES.map(value => ({
      id: scoreEmojiId(value),
      name: `Score ${value}`,
      keywords: ['score', 'grade', 'percent', String(value)],
      skins: [{ src: scoreEmojiDataUri(value) }],
    })),
  },
];

// Scores first, then emoji-mart's default order.
const CATEGORY_ORDER = [
  'scores',
  'frequent',
  'people',
  'nature',
  'foods',
  'activity',
  'places',
  'objects',
  'symbols',
  'flags',
];

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
          <Picker
            data={data}
            custom={SCORE_CATEGORY}
            categories={CATEGORY_ORDER}
            onEmojiSelect={handleEmojiSelect}
          />
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;
