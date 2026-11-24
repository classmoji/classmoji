/** The page's width setting (1-4) as the content column's class; unknown → max-w-4xl. */
const WIDTH_CLASSES: Record<number, string> = {
  1: 'max-w-2xl',
  2: 'max-w-4xl',
  3: 'max-w-5xl',
  4: 'max-w-7xl',
};

export function pageWidthClass(width: number | null | undefined): string {
  return (typeof width === 'number' && WIDTH_CLASSES[width]) || 'max-w-4xl';
}
