import TweaksSection from '~/components/features/tweaks/TweaksSection';
import { assertClassroomAccess } from '~/utils/helpers';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'SETTINGS',
    attemptedAction: 'view_personal_settings',
  });

  return { classSlug };
};

const MemberSettings = () => {
  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Settings</h1>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <div className="w-full max-w-2xl">
          <TweaksSection />
        </div>
      </div>
    </div>
  );
};

export default MemberSettings;
