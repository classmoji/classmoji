import EmojisDisplay from './EmojisDisplay';

interface Grade {
  id?: string;
  emoji: string;
  grader_id?: string | null;
  grader?: { id?: string; name: string | null } | null;
}

interface GradeBadgesProps {
  grades: Grade[] | undefined;
  emojiMappings: Record<string, unknown>;
}

/**
 * The grades on a submission, as badges, beside the grader control. Every
 * grade shows, the signed-in grader's own included: both scales now grade
 * through the hover picker, so there is no score field repeating it.
 */
const GradeBadges = ({ grades }: GradeBadgesProps) => <EmojisDisplay grades={grades ?? []} />;

export default GradeBadges;
