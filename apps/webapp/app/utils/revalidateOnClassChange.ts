import type { ShouldRevalidateFunctionArgs } from 'react-router';

/**
 * `shouldRevalidate` for a role layout (`/teacher`, `/assistant`) whose loader
 * reads per-classroom data for the nav.
 *
 * Those layouts match `/teacher` and `/assistant` for EVERY classroom — the
 * `:class` segment belongs to their child routes — so React Router's default
 * treats `/teacher/a/…` → `/teacher/b/…` as the same layout instance and keeps
 * its loader data. The classroom switcher navigates exactly that way, which
 * left the nav describing the classroom the user had just left. Re-run the
 * loader whenever the classroom changes; otherwise keep the default.
 */
export const revalidateOnClassChange = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) =>
  currentParams.class !== nextParams.class || defaultShouldRevalidate;
