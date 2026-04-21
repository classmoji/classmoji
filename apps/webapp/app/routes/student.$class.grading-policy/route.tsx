import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomMember } from '~/utils/routeAuth.server';

interface EmojiMappingRow {
  emoji: string;
  grade: number;
  extra_tokens: number;
}

interface LetterGradeMappingRow {
  letter: string;
  min_grade: number;
}

interface ClassroomSettingsShape {
  late_penalty_points_per_hour?: number | null;
  default_tokens_per_hour?: number | null;
  show_grades_to_students?: boolean | null;
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;
  const { classroom } = await requireClassroomMember(request, classSlug!, {
    resourceType: 'GRADING_POLICY',
    action: 'view_policy',
  });

  const [emojiMappings, letterGradeMappings, settings] = await Promise.all([
    ClassmojiService.emojiMapping.findByClassroomId(classroom.id, true) as unknown as Promise<
      EmojiMappingRow[]
    >,
    ClassmojiService.letterGradeMapping.findByClassroomId(classroom.id) as unknown as Promise<
      LetterGradeMappingRow[]
    >,
    ClassmojiService.classroom.getClassroomSettingsForServer(
      classroom.id
    ) as unknown as Promise<ClassroomSettingsShape | null>,
  ]);

  return {
    emojiMappings: [...emojiMappings].sort((a, b) => b.grade - a.grade),
    letterGradeMappings: [...letterGradeMappings].sort((a, b) => b.min_grade - a.min_grade),
    latePenalty: settings?.late_penalty_points_per_hour ?? 0,
    tokensPerHour: settings?.default_tokens_per_hour ?? 0,
  };
};

const StudentGradingPolicy = ({ loaderData }: Route.ComponentProps) => {
  const { emojiMappings, letterGradeMappings, latePenalty, tokensPerHour } = loaderData;
  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          Grading policy
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          How your work is evaluated in this classroom.
        </p>
      </div>

      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500 dark:text-gray-400 mb-3">
          Emoji grades
        </div>
        {emojiMappings.length === 0 ? (
          <div className="text-sm text-gray-500 dark:text-gray-400">
            No emoji mappings set yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {emojiMappings.map(m => (
              <div
                key={m.emoji}
                className="flex items-center gap-3 rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2"
              >
                <span className="text-2xl">{m.emoji}</span>
                <div className="flex flex-col">
                  <span className="font-mono text-[14px] text-gray-900 dark:text-gray-100">
                    {m.grade}
                    <span className="text-gray-400">/100</span>
                  </span>
                  {m.extra_tokens > 0 && (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400">
                      +{m.extra_tokens} tokens
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {letterGradeMappings.length > 0 && (
        <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
          <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500 dark:text-gray-400 mb-3">
            Letter grade cutoffs
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {letterGradeMappings.map(l => (
              <div
                key={l.letter}
                className="flex flex-col items-center rounded-lg border border-gray-100 dark:border-gray-800 px-3 py-2"
              >
                <span className="font-mono text-lg text-gray-900 dark:text-gray-100">
                  {l.letter}
                </span>
                <span className="text-[11px] text-gray-500 dark:text-gray-400">
                  ≥ {l.min_grade}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-5">
        <div className="text-[10.5px] uppercase tracking-wider font-semibold text-gray-500 dark:text-gray-400 mb-3">
          Late work
        </div>
        <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
          <li>
            <span className="font-semibold">Late penalty:</span>{' '}
            {latePenalty > 0
              ? `${latePenalty} point${latePenalty === 1 ? '' : 's'} deducted per hour late.`
              : 'No automatic per-hour penalty configured.'}
          </li>
          <li>
            <span className="font-semibold">Token extensions:</span>{' '}
            {tokensPerHour > 0
              ? `You can spend ${tokensPerHour} token${tokensPerHour === 1 ? '' : 's'} per hour to waive the late flag on an assignment.`
              : 'Token-funded extensions are currently disabled.'}
          </li>
          <li>
            <span className="font-semibold">Resubmits:</span> Ask a TA to re-open an assignment by
            opening a resubmit request from the assignment list.
          </li>
        </ul>
      </section>
    </div>
  );
};

export default StudentGradingPolicy;
