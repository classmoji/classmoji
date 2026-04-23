import { action } from './action';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { EmojiGradeEditor, type EmojiGradeRecord } from '~/components/features/settings';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'view_grade_settings',
  });

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id, true);

  return { emojiMappings };
};

const SettingsGrading = ({ loaderData }: Route.ComponentProps) => {
  const { emojiMappings } = loaderData;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2
        className="display"
        style={{ margin: 0, fontSize: 22, fontWeight: 500, letterSpacing: -0.3 }}
      >
        Emoji grades
      </h2>
      <EmojiGradeEditor emojiMappings={emojiMappings as unknown as EmojiGradeRecord[]} />
    </div>
  );
};

export { action };

export default SettingsGrading;
