import { isScoreScheme, parseScoreEmoji } from '@classmoji/utils';
import { useUser } from '~/hooks';
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
 * The grades on a submission, as badges, beside the grader control. On a
 * numeric scale the signed-in grader's own score is already in the score
 * field next to this, so it is not repeated here; only other graders' scores
 * show. Glyph scales show every emoji, as always.
 */
const GradeBadges = ({ grades, emojiMappings }: GradeBadgesProps) => {
  const { user } = useUser();
  const all = grades ?? [];
  if (!isScoreScheme(Object.keys(emojiMappings))) return <EmojisDisplay grades={all} />;

  const others = all.filter(
    g => (g.grader_id ?? g.grader?.id) !== user?.id || parseScoreEmoji(g.emoji) === null
  );
  if (others.length === 0) return null;
  return <EmojisDisplay grades={others} />;
};

export default GradeBadges;
