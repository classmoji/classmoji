import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { useState } from 'react';
import { useClickAway } from '@uidotdev/usehooks';
import { Emoji } from '~/components';

const EmojiPicker = ({ setEmoji, emoji }) => {
  const [isOpen, setIsOpen] = useState(false);

  const handleEmojiSelect = emoji => {
    setIsOpen(false);
    setEmoji(emoji.id);
  };

  const ref = useClickAway(() => {
    setIsOpen(false);
  });

  return (
    <div className="relative w-full">
      <div
        onClick={() => setIsOpen(true)}
        className="h-[75px]  border border-gray-300 rounded-md cursor-pointer"
      >
        {emoji ? (
          <Emoji
            emoji={emoji}
            fontSize={40}
            className="flex items-center justify-center w-full h-full"
          />
        ) : (
          <p className="text-gray-500 text-center flex items-center justify-center h-full">
            Choose an emoji
          </p>
        )}
      </div>

      {isOpen && (
        <div className="absolute top-[85px] transform z-10 shadow-lg" ref={ref}>
          <Picker data={data} onEmojiSelect={handleEmojiSelect} />
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;
