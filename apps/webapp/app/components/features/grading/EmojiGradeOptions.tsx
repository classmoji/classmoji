import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useGlobalFetcher, useUser } from '~/hooks';

import { ActionTypes } from '~/constants';
import { EASE_OUT_QUINT, POP_SPRING } from '~/utils/motion';
import useStore from '~/store';
import Emoji from '../../ui/display/Emoji';

export interface GraderGrade {
  id: string;
  emoji: string;
  grader_id?: string | null;
  grader?: { id?: string; name: string | null } | null;
  created_at?: string | Date;
  token_transaction?: {
    amount: number;
  } | null;
}

export interface GraderRepositoryAssignment {
  id: string;
  assignment_id?: string;
  studentId?: string;
  teamId?: string;
  grades?: GraderGrade[];
  repository?: { name?: string | null } | null;
}

interface EmojiGradeOptionsProps {
  repositoryAssignment: GraderRepositoryAssignment;
  emojiMappings: Record<string, unknown>;
  /** The wrapper's test id: the popover's, or the panel's inline picker's. */
  testId?: string;
  className?: string;
  /**
   * Only the viewer's own grades count as selected, and only they are removed
   * on a click: for a surface that lists the other graders' grades on their
   * own (the submission panel). Off, any grader's grade does, as before.
   */
  viewerGradesOnly?: boolean;
  /** Every option is inert, e.g. while another change to this submission is in flight. */
  disabled?: boolean;
}

/**
 * The classroom's grade options for one submission: click an option to add
 * that grade, click a selected one to remove it. Grades through
 * `/api/gitRepoAssignment` (its gate, audit and stacking rules). Shared by the
 * hover picker (EmojiGrader) and the gradebook's submission panel.
 */
const EmojiGradeOptions = ({
  repositoryAssignment,
  emojiMappings,
  testId,
  className = 'flex flex-wrap gap-2',
  viewerGradesOnly = false,
  disabled = false,
}: EmojiGradeOptionsProps) => {
  const [poppedKey, setPoppedKey] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const { fetcher, notify } = useGlobalFetcher();
  const { user } = useUser();
  const { classroom } = useStore();

  const assignmentData = () => ({
    id: repositoryAssignment.id,
    assignment_id: repositoryAssignment.assignment_id ?? null,
    studentId: repositoryAssignment.studentId ?? null,
    teamId: repositoryAssignment.teamId ?? null,
  });

  const assignGrade = (emoji: string) => {
    setPoppedKey(emoji);
    notify(ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT, 'Assigning grade...');

    fetcher!.submit(
      {
        repoName: repositoryAssignment.repository?.name ?? null,
        gitRepoAssignment: assignmentData(),
        graderId: user!.id,
        grade: emoji,
        studentId: repositoryAssignment.studentId ?? null,
        teamId: repositoryAssignment.teamId ?? null,
      },
      {
        method: 'post',
        action: `/api/gitRepoAssignment/${classroom?.slug}?action=addGrade`,
        encType: 'application/json',
      }
    );
  };

  // The grades a click can select or remove.
  const counted = (repositoryAssignment.grades ?? []).filter(
    grade => !viewerGradesOnly || grade.grader_id === user?.id
  );

  const removeGrade = (emoji: string) => {
    notify(ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT, 'Removing grade...');

    const gradeToRemove = counted.find(grade => grade.emoji === emoji);

    fetcher!.submit(
      {
        repoName: repositoryAssignment.repository?.name ?? null,
        gitRepoAssignment: assignmentData(),
        grade: gradeToRemove
          ? {
              id: gradeToRemove.id,
              emoji: gradeToRemove.emoji,
              token_transaction: gradeToRemove.token_transaction ?? null,
            }
          : null,
      },
      {
        method: 'post',
        action: `/api/gitRepoAssignment/${classroom?.slug}?action=removeGrade`,
        encType: 'application/json',
      }
    );
  };

  // Both scales grade through the picker. On the numeric scale the options are
  // the score badges and the server keeps one score per grader, so picking a
  // second badge replaces the first.
  const scaleKeys = Object.keys(emojiMappings);

  return (
    <div data-testid={testId} className={className}>
      {scaleKeys.map(key => {
        const isSelected = counted.some(grade => grade.emoji === key);
        const isPopped = poppedKey === key && !reducedMotion;
        // Outer wrapper owns the celebratory bounce, inner button owns hover/tap, so
        // the gesture animations don't suppress the keyframe bounce on the same element.
        return (
          <motion.span
            key={key}
            data-testid={`emoji-grade-option-${key}`}
            data-selected={isSelected ? 'true' : 'false'}
            aria-pressed={isSelected}
            className="inline-flex shrink-0"
            animate={isPopped ? { scale: [1, 1.35, 0.92, 1] } : { scale: 1 }}
            transition={isPopped ? { duration: 0.4, ease: EASE_OUT_QUINT } : { duration: 0 }}
            onAnimationComplete={() => {
              if (poppedKey === key) setPoppedKey(null);
            }}
          >
            <motion.button
              type="button"
              disabled={disabled}
              className="cursor-pointer px-2 py-1 rounded-md hover:bg-slate-200 dark:hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundColor: isSelected ? '#ffebc2' : 'transparent',
              }}
              whileHover={reducedMotion || disabled ? undefined : { scale: 1.18, y: -2 }}
              whileTap={reducedMotion || disabled ? undefined : { scale: 0.85 }}
              transition={POP_SPRING}
              onClick={() => {
                if (disabled) return;
                if (isSelected) {
                  removeGrade(key);
                } else assignGrade(key);
              }}
            >
              <Emoji emoji={key} />
            </motion.button>
          </motion.span>
        );
      })}
    </div>
  );
};

export default EmojiGradeOptions;
