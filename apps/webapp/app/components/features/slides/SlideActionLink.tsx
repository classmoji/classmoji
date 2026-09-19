/**
 * One action in a slide row's action column, as a real link.
 *
 * The slides app lives on another origin, so every one of these is an anchor
 * with `target="_blank"` rather than an `onClick` — a Download or an Open has
 * to be middle-clickable and copyable like any other link.
 *
 * ## Every colour variant is `!important`, deliberately
 *
 * An `<a>` is styled by unlayered global/antd CSS, and unlayered rules beat
 * Tailwind's `utilities` layer whatever the source order. A plain
 * `hover:text-gray-800` next to an `!text-gray-600` therefore never applied —
 * exactly the bug fixed for the Present link in 3e06e68c (light-mode hover) and
 * for these lists' titles in 05f8fe57 (dark mode). Keep the markers.
 */

interface SlideActionLinkProps {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const SlideActionLink = ({ href, icon, children }: SlideActionLinkProps) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="flex items-center gap-1 !text-gray-600 hover:!text-gray-800 dark:!text-gray-300 dark:hover:!text-gray-100 no-underline cursor-pointer"
  >
    {icon}
    <span>{children}</span>
  </a>
);

export default SlideActionLink;
