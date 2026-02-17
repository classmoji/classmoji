import EmojiConvertor from 'emoji-js';

const emojiConvertor = new EmojiConvertor();
emojiConvertor.replace_mode = 'unified'; // Convert to Unicode emojis
emojiConvertor.allow_native = true;

const Emoji = ({ emoji, fontSize = 16, className = '' }) => {
  return (
    <span className={`${className} cursor-pointer relative`} style={{ fontSize }}>
      {emojiConvertor.replace_colons(`:${emoji}:`)}
    </span>
  );
};

export default Emoji;
