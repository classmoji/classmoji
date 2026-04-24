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
    <div className="min-h-full flex flex-col gap-4">
      <h1 className="mt-2 mb-1 text-base font-semibold text-gray-600 dark:text-gray-400">
        Settings
      </h1>
      <div className="w-full max-w-2xl space-y-6">
        <TweaksSection />
      </div>
    </div>
  );
};

export default MemberSettings;
