import EmojiConvertor from 'emoji-js';

// Convert emoji shortcode to unicode
const emojiConvertor = new EmojiConvertor();
emojiConvertor.replace_mode = 'unified';
emojiConvertor.allow_native = true;

export const convertEmoji = shortcode => {
  if (!shortcode) return '💡';
  // If it's already a unicode emoji, return as-is
  if (/\p{Emoji}/u.test(shortcode)) return shortcode;
  // Otherwise convert from shortcode
  return emojiConvertor.replace_colons(`:${shortcode}:`);
};

// Extract content from HTML (remove HTML boilerplate, keep body content)
export function htmlToMarkdown(html) {
  if (!html) return '';

  // Extract body content between <body> tags
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!bodyMatch) return html;

  let content = bodyMatch[1].trim();

  // Remove title and subtitle (first h1 and p.subtitle)
  content = content.replace(/<h1[^>]*>.*?<\/h1>/i, '');
  content = content.replace(/<p class="subtitle"[^>]*>.*?<\/p>/i, '');

  return content.trim();
}
