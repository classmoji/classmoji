import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Popover } from 'antd';
import { useGlobalFetcher, useUser } from '~/hooks';

import { ActionTypes } from '~/constants';
import { EASE_OUT_QUINT, POP_SPRING } from '~/utils/motion';
import useStore from '~/store';
import Emoji from '../../ui/display/Emoji';

interface Grade {
  id: string;
  emoji: string;
  grader_id?: string | null;
  grader?: { id?: string; name: string | null } | null;
  created_at?: string | Date;
  token_transaction?: {
    amount: number;
  } | null;
}

interface RepositoryAssignment {
  id: string;
  assignment_id?: string;
  studentId?: string;
  teamId?: string;
  grades?: Grade[];
  repository?: { name?: string | null } | null;
}

interface EmojiGraderProps {
  repositoryAssignment: RepositoryAssignment;
  emojiMappings: Record<string, unknown>;
}

const EmojiGrader = ({ repositoryAssignment, emojiMappings }: EmojiGraderProps) => {
  const [show, setShow] = useState(false);
  const [poppedKey, setPoppedKey] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const { fetcher, notify } = useGlobalFetcher();
  const { user } = useUser();
  const { classroom } = useStore();

  const assignGrade = (emoji: string) => {
    setPoppedKey(emoji);
    notify(ActionTypes.ADD_GRADE_TO_GIT_REPO_ASSIGNMENT, 'Assigning grade...');

    const { repository, ...assignmentWithoutCircular } = repositoryAssignment;
    const assignmentData = {
      id: assignmentWithoutCircular.id,
      assignment_id: assignmentWithoutCircular.assignment_id ?? null,
      studentId: assignmentWithoutCircular.studentId ?? null,
      teamId: assignmentWithoutCircular.teamId ?? null,
    };

    fetcher!.submit(
      {
        repoName: repository?.name ?? null,
        gitRepoAssignment: assignmentData,
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

  const removeGrade = (emoji: string) => {
    notify(ActionTypes.REMOVE_GRADE_FROM_GIT_REPO_ASSIGNMENT, 'Removing grade...');

    const { repository, ...assignmentWithoutCircular } = repositoryAssignment;
    const assignmentData = {
      id: assignmentWithoutCircular.id,
      assignment_id: assignmentWithoutCircular.assignment_id ?? null,
      studentId: assignmentWithoutCircular.studentId ?? null,
      teamId: assignmentWithoutCircular.teamId ?? null,
    };
    const gradeToRemove = repositoryAssignment.grades?.find(
      (grade: Grade) => grade.emoji === emoji
    );

    fetcher!.submit(
      {
        repoName: repository?.name ?? null,
        gitRepoAssignment: assignmentData,
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

  const emojiList = scaleKeys.map(key => {
    const isSelected = repositoryAssignment.grades?.some((grade: Grade) => grade.emoji === key);
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
          className="cursor-pointer px-2 py-1 rounded-md hover:bg-slate-200 dark:hover:bg-neutral-700"
          style={{
            backgroundColor: isSelected ? '#ffebc2' : 'transparent',
          }}
          whileHover={reducedMotion ? undefined : { scale: 1.18, y: -2 }}
          whileTap={reducedMotion ? undefined : { scale: 0.85 }}
          transition={POP_SPRING}
          onClick={() => {
            if (isSelected) {
              removeGrade(key);
            } else assignGrade(key);
          }}
        >
          <Emoji emoji={key} />
        </motion.button>
      </motion.span>
    );
  });

  return (
    <Popover
      // Hover opens it; a click must keep it open, not toggle it shut (a click
      // trigger on top of hover closes what the hover just opened).
      trigger="hover"
      mouseEnterDelay={0.15}
      open={show}
      onOpenChange={setShow}
      placement="top"
      overlayInnerStyle={{ padding: '10px 12px' }}
      content={
        <div data-testid="emoji-grade-popover" className="flex flex-wrap gap-2 max-w-[23rem]">
          {emojiList}
        </div>
      }
    >
      <button
        type="button"
        onClick={() => setShow(true)}
        data-testid="emoji-grade-trigger"
        className="text-sm font-medium text-ink-2 hover:text-ink-1 hover:underline underline-offset-2 cursor-pointer"
      >
        Grade
      </button>
    </Popover>
  );
};

export default EmojiGrader;
