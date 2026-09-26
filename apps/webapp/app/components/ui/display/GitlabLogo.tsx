import gitlabLogo from './gitlab.svg';

/**
 * Gitlab's official tanuki logo (the same file the sign-in button uses). Use
 * this for every Gitlab mark in the app, never an outline icon-set glyph.
 */
export const GitlabLogo = ({ size = 16, className = '' }: { size?: number; className?: string }) => (
  <img
    src={gitlabLogo}
    alt=""
    aria-hidden
    width={size}
    height={size}
    className={`inline-block shrink-0 align-[-0.125em] ${className}`}
  />
);

export default GitlabLogo;
