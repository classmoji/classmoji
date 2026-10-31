import { useEffect, useRef } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

/**
 * emoji-mart's full picker. Its own module so the picker and its data (a few
 * hundred KB) load only when someone asks for "more" (`React.lazy` in
 * ReactionPicker.tsx), never with the page.
 *
 * Focus goes to its search box once it is up (emoji-mart builds its element,
 * in a shadow root, after this mounts, so its own `autoFocus` can miss), so
 * the keyboard stays in the picker and Escape reaches ReactionPicker.
 */
export default function EmojiMartPicker({
  onSelect,
  dark,
}: {
  onSelect: (emoji: string) => void;
  dark: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const focusSearch = () => {
      const host = ref.current?.querySelector('em-emoji-picker');
      const input = host?.shadowRoot?.querySelector<HTMLInputElement>(
        'input[type="search"], input'
      );
      if (input) {
        input.focus();
        return;
      }
      if (++tries < 60) frame = requestAnimationFrame(focusSearch);
    };
    frame = requestAnimationFrame(focusSearch);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div ref={ref}>
      <Picker
        data={data}
        theme={dark ? 'dark' : 'light'}
        autoFocus
        previewPosition="none"
        skinTonePosition="search"
        onEmojiSelect={(emoji: { native?: string }) => {
          if (emoji.native) onSelect(emoji.native);
        }}
      />
    </div>
  );
}
