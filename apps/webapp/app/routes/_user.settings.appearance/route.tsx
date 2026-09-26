import { requireAuth } from '@classmoji/auth/server';
import TweaksSection from '~/components/features/tweaks/TweaksSection';
import type { Route } from './+types/route';

export const loader = async ({ request }: Route.LoaderArgs) => {
  await requireAuth(request);
  return null;
};

const SettingsAppearance = () => (
  <div className="w-2/3">
    <TweaksSection />
  </div>
);

export default SettingsAppearance;
