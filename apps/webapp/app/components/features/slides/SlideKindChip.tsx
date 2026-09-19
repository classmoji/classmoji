/**
 * The little uppercase chip a slide list draws in front of a title.
 *
 * A `Slide` is no longer always a reveal.js deck: it can be an uploaded
 * document students download (`kind: 'FILE'`) or an external URL they are
 * redirected to (`'LINK'`). Every row in a list of them therefore has to say
 * WHICH, because the actions beside it differ and so does what clicking the
 * title does — download a PDF, or leave for another site.
 *
 * `label` is whatever `slideKindLabel()` in `@classmoji/services` returned for
 * the row: `deck`, the file's extension (`pdf`/`pptx`/`ppt`/`key`), `file` for
 * anything else, or `link`. It is computed in the LOADER and passed down as a
 * plain string — importing the services barrel into component code would drag
 * Prisma and the deck parser into the client bundle.
 *
 * ## The colours, and why the border needs `!`
 *
 * `.chip` and the tone variables come from the shared design system
 * (`packages/ui-components/styles`), so a tone is one class pair rather than a
 * `dark:` variant for every property: `--mint-bg` and friends are redefined
 * under `html.dark`, and the chip follows the theme on its own.
 *
 * `.chip` itself is unlayered CSS (global.css imports components.css directly),
 * and unlayered rules beat anything in Tailwind's `utilities` layer regardless
 * of source order. Its `border: 1px solid transparent` would therefore win over
 * a plain `border-*-bord` utility, which is why the border colour — and only
 * the border colour, since `.chip` sets no background or text colour — carries
 * the important marker. Same reason the title links on these lists use
 * `!text-*`.
 */

/** deck → mint, pdf → peach, the PowerPoint/Keynote family → amber, link → sky. */
const KIND_TONES: Record<string, string> = {
  deck: 'bg-mint-bg text-mint-ink !border-mint-bord',
  pdf: 'bg-peach-bg text-peach-ink !border-peach-bord',
  pptx: 'bg-amber-bg text-amber-ink !border-amber-bord',
  ppt: 'bg-amber-bg text-amber-ink !border-amber-bord',
  key: 'bg-amber-bg text-amber-ink !border-amber-bord',
  link: 'bg-sky-bg text-sky-ink !border-sky-bord',
};

interface SlideKindChipProps {
  /** `slideKindLabel(slide)` — deck | pdf | pptx | ppt | key | file | link. */
  label: string;
}

const SlideKindChip = ({ label }: SlideKindChipProps) => (
  // `chip-ghost` is the neutral fallback: an allowed extension we have no tone
  // for reads as a plain file rather than borrowing a colour that means
  // something else.
  <span className={`chip shrink-0 ${KIND_TONES[label] ?? 'chip-ghost'}`}>{label}</span>
);

export default SlideKindChip;
