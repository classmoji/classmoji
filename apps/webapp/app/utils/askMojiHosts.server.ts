/**
 * The pages and slides app URLs Ask Moji needs: the origins allowed to frame
 * its embed, and the base of the links its source chips open.
 *
 * The development defaults apply only outside production. In production an
 * unset URL is null: the embed then frames for nobody, and a chip to that app
 * is a label rather than a link that goes nowhere.
 */
type Env = Record<string, string | undefined>;

export function askMojiHostUrls(env: Env = process.env): {
  pagesUrl: string | null;
  slidesUrl: string | null;
} {
  const dev = env.NODE_ENV !== 'production';
  return {
    pagesUrl: env.PAGES_URL || (dev ? 'http://localhost:7100' : null),
    slidesUrl: env.SLIDES_URL || (dev ? 'http://localhost:6500' : null),
  };
}
