import { Divider } from 'antd';

import { action } from './action';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import EmojiMapping from './EmojiMapping';
import LetterGradeMapping from './LetterGradeMapping';
import GradingSettingsOptions from './GradingSettingsOptions';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'SETTINGS',
    action: 'view_grade_settings',
  });

  const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id, true);
  const letterGradeMappings = await ClassmojiService.letterGradeMapping.findByClassroomId(
    classroom.id
  );
  const orphanedEmojis = await ClassmojiService.assignmentGrade.findOrphanedGradeEmojis(
    classroom.id
  );

  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  return { emojiMappings, letterGradeMappings, orphanedEmojis, settings };
};

const SettingsGrading = ({ loaderData }: Route.ComponentProps) => {
  const { emojiMappings, letterGradeMappings, orphanedEmojis, settings } = loaderData;

  return (
    <div className="">
      <GradingSettingsOptions
        settings={
          settings as unknown as React.ComponentProps<typeof GradingSettingsOptions>['settings']
        }
      />
      <Divider />
      <EmojiMapping
        emojiMappings={
          emojiMappings as unknown as Array<{
            emoji: string;
            grade: number;
            extra_tokens: number;
            description: string;
            [key: string]: unknown;
          }>
        }
        orphanedEmojis={orphanedEmojis}
      />
      <Divider />
      <LetterGradeMapping letterGradeMappings={letterGradeMappings} />
    </div>
  );
};

export { action };

export default SettingsGrading;
