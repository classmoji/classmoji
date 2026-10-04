/** Class recipes that mirror the Classmoji webapp design spec. */

export type ChipTone = 'mint' | 'peach' | 'sky' | 'lilac' | 'amber' | 'rose' | 'neutral';
type ButtonVariant = 'default' | 'primary' | 'ghost';
type ButtonSize = 'md' | 'sm';

export const ui = {
  app: 'bg-app dark:bg-app-dark',
  card: 'rounded-2xl bg-panel shadow-card ring-1 ring-edge dark:bg-panel-dark dark:ring-edge-dark',
  cardMd: 'rounded-lg bg-panel shadow-card ring-1 ring-edge dark:bg-panel-dark dark:ring-edge-dark',
  floating: 'rounded-lg bg-panel shadow-float ring-1 ring-edge dark:bg-panel-dark dark:ring-line-2-dark',
  ink0: 'text-ink-0 dark:text-inkd-0',
  ink1: 'text-ink-1 dark:text-inkd-1',
  ink2: 'text-ink-2 dark:text-inkd-2',
  ink3: 'text-ink-3 dark:text-inkd-3',
  ink4: 'text-ink-4 dark:text-inkd-4',
  divider: 'border-line dark:border-line-dark',
  selected: 'bg-accent-soft dark:bg-accent-soft-dark',
  selectedInk: 'text-accent-ink dark:text-accent-ink-dark',
  subtle: 'bg-stone-100 dark:bg-panel-hover-dark',
  rowHover: 'transition-colors duration-150 hover:bg-panel-hover dark:hover:bg-panel-hover-dark',
  tableHead: 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3 dark:text-inkd-3',
  input:
    'rounded-md border border-line-2 bg-panel px-3 py-2 text-[13px] text-ink-0 placeholder:text-ink-4 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 dark:border-line-2-dark dark:bg-panel-dark dark:text-inkd-0 dark:placeholder:text-inkd-4',
  segment: 'flex rounded-md bg-stone-100 p-0.5 text-[12px] font-medium dark:bg-app-dark',
  focus:
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-panel dark:focus-visible:ring-offset-panel-dark',
};

const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap border font-medium transition-colors duration-150 disabled:cursor-default';

const BTN_SIZE: Record<ButtonSize, string> = {
  md: 'h-8 rounded-md px-3 text-[13px]',
  sm: 'h-[26px] rounded-[7px] px-2.5 text-[12px]',
};

const BTN_VARIANT: Record<ButtonVariant, string> = {
  default:
    'border-line-2 bg-panel text-ink-0 hover:border-line-strong disabled:text-ink-3 disabled:hover:border-line-2 dark:border-line-2-dark dark:bg-panel-dark dark:text-inkd-0 dark:hover:border-line-strong-dark dark:disabled:text-inkd-3 dark:disabled:hover:border-line-2-dark',
  primary:
    'border-accent bg-accent text-white hover:border-accent-hover hover:bg-accent-hover disabled:opacity-50 disabled:hover:border-accent disabled:hover:bg-accent',
  ghost: 'border-transparent bg-transparent text-ink-1 hover:bg-navhover dark:text-inkd-1 dark:hover:bg-navhover-dark',
};

export function button(variant: ButtonVariant = 'default', size: ButtonSize = 'md'): string {
  return `${BTN_BASE} ${BTN_SIZE[size]} ${BTN_VARIANT[variant]} ${ui.focus}`;
}

const CHIP_TONES: Record<ChipTone, string> = {
  mint: 'border-mint-line bg-mint-bg text-mint-ink dark:border-mint-line-dark dark:bg-mint-bg-dark dark:text-mint-ink-dark',
  peach: 'border-peach-line bg-peach-bg text-peach-ink dark:border-peach-line-dark dark:bg-peach-bg-dark dark:text-peach-ink-dark',
  sky: 'border-sky-line bg-sky-bg text-sky-ink dark:border-sky-line-dark dark:bg-sky-bg-dark dark:text-sky-ink-dark',
  lilac: 'border-lilac-line bg-lilac-bg text-lilac-ink dark:border-lilac-line-dark dark:bg-lilac-bg-dark dark:text-lilac-ink-dark',
  amber: 'border-amber-line bg-amber-bg text-amber-ink dark:border-amber-line-dark dark:bg-amber-bg-dark dark:text-amber-ink-dark',
  rose: 'border-rose-line bg-rose-bg text-rose-ink dark:border-rose-line-dark dark:bg-rose-bg-dark dark:text-rose-ink-dark',
  neutral: 'border-edge bg-stone-100 text-ink-2 dark:border-line-2-dark dark:bg-panel-hover-dark dark:text-inkd-2',
};

export function chip(tone: ChipTone, caps = false): string {
  return `inline-flex items-center gap-1 whitespace-nowrap rounded-[6px] border px-2 py-[2px] text-[11px] font-semibold ${
    caps ? 'uppercase tracking-[0.04em]' : ''
  } ${CHIP_TONES[tone]}`;
}

export function segmentItem(active: boolean): string {
  return `rounded-[6px] px-2.5 py-1 ring-1 transition-colors duration-150 ${
    active
      ? 'bg-panel text-ink-0 shadow-card ring-edge dark:bg-panel-dark dark:text-inkd-0 dark:ring-edge-dark'
      : 'text-ink-3 ring-transparent hover:text-ink-0 dark:text-inkd-3 dark:hover:text-inkd-0'
  }`;
}
