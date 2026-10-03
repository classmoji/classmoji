import { requireAuth } from '@classmoji/auth/server';
import TweaksSection from '~/components/features/tweaks/TweaksSection';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireAuth(request);
  return null;
};

// Personal look and feel, kept in this browser (see useDarkMode). Applies in
// every classroom, so it lives in account settings rather than a class's.
const SettingsAppearance = () => (
  <div className="w-full max-w-2xl">
    <TweaksSection />
  </div>
);

export default SettingsAppearance;
