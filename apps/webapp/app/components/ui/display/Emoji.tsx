import EmojiConvertor from 'emoji-js';
import { parseScoreEmoji, scoreEmojiDataUri } from '@classmoji/utils';

const emojiConvertor = new EmojiConvertor();
emojiConvertor.replace_mode = 'unified'; // Convert to Unicode emojis
emojiConvertor.allow_native = true;

export interface EmojiProps {
  emoji: string;
  fontSize?: number | string;
  className?: string;
  logo?: boolean;
  size?: string;
}

const BADGE_SIZE: Record<string, string> = { sm: '1.25em', lg: '2.25em' };

/** emoji-js shortcode names: letters, digits, `_`, `+`, `-`. */
const SHORTCODE = /^[a-z0-9_+-]+$/i;

const Emoji = ({ emoji, fontSize = 16, className = '', size }: EmojiProps) => {
  // `score-N` is a built-in image emoji (a number badge), not a unicode
  // shortcode. The wrapper keeps `fontSize` so callers size it exactly like a
  // glyph. The badge is a bit larger than a glyph's box so the number stays
  // legible; `size` picks a smaller or larger variant where a caller asks.
  const score = parseScoreEmoji(emoji);
  if (score !== null) {
    const badgeSize = (size && BADGE_SIZE[size]) || '1.6em';
    return (
      <span
        className={`${className} cursor-pointer relative inline-flex shrink-0 items-center align-middle`}
        style={{ fontSize }}
      >
        <img
          src={scoreEmojiDataUri(score)}
          alt={String(score)}
          title={`${score} / 100`}
          draggable={false}
          style={{ height: badgeSize, width: badgeSize, flexShrink: 0 }}
        />
      </span>
    );
  }

  // A scale stores either a shortcode (`heart`, `+1`) or the glyph itself
  // (`🟢`). Only a shortcode goes through the colon lookup; a glyph wrapped in
  // colons would come back as the literal text ":🟢:".
  const glyph = SHORTCODE.test(emoji) ? emojiConvertor.replace_colons(`:${emoji}:`) : emoji;

  return (
    <span className={`${className} cursor-pointer relative`} style={{ fontSize }}>
      {glyph}
    </span>
  );
};

export default Emoji;
